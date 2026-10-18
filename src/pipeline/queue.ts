import { hasQueuedLabel } from "../github/labels.ts";
import { enforceLabeler } from "../github/labeler.ts";
import { blockerRefs, isDone, isLiveShape, resumeBlocked, type IssueInfo } from "../github/issues.ts";
import { markTrust } from "../github/trust.ts";
import { listQueued } from "../github/queue.ts";
import { describeQueue, orderQueue, PRIORITY_LABELS, type Queued } from "../core/priority.ts";
import { $ } from "bun";
import { emit } from "../core/events.ts";
import { output } from "../core/output.ts";
import { AgentFailure } from "./errors.ts";
import { runIssue, type IssueOptions, type IssueResult } from "./issue.ts";

export interface QueueOptions extends Omit<IssueOptions, "issue"> {
  /** Max issues per run. Defaults to 5. */
  limit?: number;
  /** Delay before re-listing once, always, to catch issues the first list missed (gh lags label changes). Defaults to 3000. */
  listRetryMs?: number;
  /** Don't stop at the first non-merged outcome; an issue run that throws becomes a `failed` entry. For unattended callers that handle failures in `onResult`. */
  keepGoing?: boolean;
  /** Checked before each issue; true ends the pass without starting another. */
  shouldStop?: () => boolean;
  /** Issues for which this returns true are not started. */
  skip?: (issue: number) => boolean | Promise<boolean>;
  /** Re-list between issues so a newly labelled bug or `priority:high` issue runs next. For long-lived callers (`--watch`). */
  relist?: boolean;
  /** Called after each issue run (not before the next one starts when `parallel` > 1). */
  onResult?: (entry: QueueEntry) => void | Promise<void>;
  /**
   * Issues worked at once, each in its own worktree and sandbox. Defaults to 1. Above 1, PRs are merged one at a time in queue
   * order, each after the branch is brought up to date with the default branch and re-verified; a conflict or a verify failure
   * at that point gets one fresh attempt from the new default branch. Needs `merge`.
   */
  parallel?: number;
  /** GitHub logins besides repo admins and maintainers whose `bunker:queued` label may queue work. */
  allowLabelers?: string[];
  /** Called with an issue whose labeler check refused it (lookup failed or not permitted), so a long-lived caller can stop re-checking it. */
  onRefused?: (issue: number) => void;
}

export interface QueueEntry extends IssueResult {
  issue: number;
  title: string;
  /** Spend of an earlier attempt that was thrown away and retried (the entry itself covers the last attempt). */
  priorCostUsd?: number;
}

/**
 * Works open issues labelled `bunker:queued` (priority:high → medium → none → low; bugs first within a priority; then oldest first), `parallel` at a time (default one). Without `merge`
 * stops after the first PR opens; with `merge` continues only after `merged`.
 * Stops starting issues at the first other outcome, or after `limit` issues.
 */
export async function runQueue({ limit = 5, listRetryMs = 3000, keepGoing, shouldStop, skip, onResult, parallel = 1, relist, allowLabelers, onRefused, ...opts }: QueueOptions): Promise<QueueEntry[]> {
  const cwd = opts.cwd ?? process.cwd();
  const token = process.env.BUNKER_GH_TOKEN;
  const env = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
  const listIssues = () => listQueued(cwd, env);
  // `gh issue list` lags the label swap, so the issues just relabelled go straight into the queue.
  const resumedNow = new Map<number, Queued>();
  const addResumed = (qs: Queued[]) => qs.forEach((q) => resumedNow.set(q.number, q));
  addResumed(await resumeBlocked(cwd, env));
  for (const p of PRIORITY_LABELS) await $`gh label create ${p.name} --description ${"bunker queue priority"} --color ${p.color}`.cwd(cwd).env(env).nothrow().quiet();
  // The list can lag with a partial result too, so always list twice and merge.
  const first = await listIssues();
  await Bun.sleep(listRetryMs);
  const merged = new Map([...first, ...(await listIssues())].map((q) => [q.number, q]));
  for (const q of resumedNow.values()) if (!merged.has(q.number)) merged.set(q.number, q);
  let queue = orderQueue([...merged.values()]);
  const seen = new Set<number>();
  let announced = "";
  let announcedOrder: number[] = [];
  const announce = (reason?: string) => {
    const rest = queue.filter((c) => !seen.has(c.number));
    const text = describeQueue(rest);
    if (!rest.length || text === announced) return;
    announced = text;
    // Only a change in the relative order of issues listed both times counts; started and newly listed ones don't.
    const now = rest.map((c) => c.number);
    const kept = announcedOrder.filter((n) => now.includes(n));
    const nowKept = now.filter((n) => kept.includes(n));
    announcedOrder = now;
    if (reason === "re-ordered" && kept.every((n, i) => n === nowKept[i])) reason = undefined;
    const order = reason ? `${text} (${reason})` : text;
    emit(opts.onEvent, { type: "note", text: order });
    orderNote = text;
  };
  let orderNote = "";
  announce();
  /** The next candidate; under `relist` the order is re-evaluated first, so a relabelled issue jumps the queue. */
  const next = async () => {
    if (relist && seen.size) {
      const fresh = await listIssues();
      if (fresh.length || resumedNow.size) {
        queue = orderQueue([...fresh, ...[...resumedNow.values()].filter((r) => !fresh.some((f) => f.number === r.number))]);
        announce("re-ordered");
      }
    }
    const q = queue.find((c) => !seen.has(c.number));
    if (q) seen.add(q.number);
    return q;
  };
  const done: (QueueEntry | undefined)[] = [];
  /** In-flight issues by number: also the lock that keeps two slots off the same issue. */
  const active = new Map<number, Promise<void>>();
  let counted = 0; // started and not (known to be) blocked
  let stop = false;
  let fatal: { error: unknown } | undefined;
  // Merge turns: an issue publishes only after every earlier-started issue has finished.
  let previous: Promise<void> = Promise.resolve();
  const cost = (r: IssueResult) => (r.review?.usage ?? r.usage)?.costUsd ?? 0;

  const work = async (q: { number: number; title: string }, index: number, before: Promise<void>, release: () => void) => {
    const mergeTurn = parallel > 1 ? (run: () => Promise<IssueResult>) => before.then(run) : undefined;
    const attempt = async (n: number): Promise<IssueResult> => {
      try {
        return await runIssue({ ...opts, cwd, issue: q.number, ...(orderNote ? { queueOrder: orderNote } : {}), ...(mergeTurn ? { mergeTurn, attempt: n } : {}) });
      } catch (e) {
        if (!keepGoing) throw e;
        const usage = e instanceof AgentFailure ? e.usage : undefined;
        return { status: "failed", branch: "", worktree: "", filed: [], ...(usage ? { usage } : {}), error: e instanceof Error ? e.message : String(e) };
      }
    };
    try {
      let result = await attempt(1);
      let priorCostUsd = 0;
      if (result.stale) {
        output.warn(`bunker: #${q.number} ${result.status} after updating to the latest main; trying once more from the new base`);
        priorCostUsd = cost(result);
        result = await attempt(2);
      }
      const entry: QueueEntry = { ...result, issue: q.number, title: q.title, ...(priorCostUsd ? { priorCostUsd } : {}) };
      done[index] = entry;
      if (result.status === "blocked") counted--;
      await onResult?.(entry);
      // Every other issue would hit the same limit; stop starting new ones.
      if (result.status === "paused-usage-limit") {
        stop = true;
        return;
      }
      if (result.status === "merged") {
        const more = await resumeBlocked(cwd, env);
        addResumed(more);
        const known = new Set(queue.map((c) => c.number));
        queue = orderQueue([...queue, ...more.filter((m) => !known.has(m.number))]);
      }
      else if (result.status === "blocked") return;
      if (!keepGoing && (!opts.merge || result.status !== "merged")) stop = true;
    } catch (e) {
      fatal ??= { error: e };
      stop = true;
    } finally {
      release();
    }
  };

  let index = 0;
  for (;;) {
    while (active.size >= parallel || (counted >= limit && active.size > 0)) await Promise.race(active.values());
    if (stop || counted >= limit || shouldStop?.()) break;
    const q = await next();
    if (!q) break;
    if (active.has(q.number) || (await skip?.(q.number))) continue;
    // The list lags label changes by seconds, so confirm the live state before working it.
    const view = await $`gh issue view ${q.number} --json state,labels,body,author,comments`.cwd(cwd).env(env).nothrow().quiet();
    if (view.exitCode !== 0) {
      // A transient API error on one candidate must not discard the results already collected.
      output.warn(`bunker: skipping #${q.number}, gh issue view failed:\n${view.stderr}`);
      continue;
    }
    let live: Pick<IssueInfo, "state" | "labels" | "body" | "author" | "comments" | "bodyTrusted">;
    try {
      live = JSON.parse(view.stdout.toString());
      if (live === null || typeof live !== "object" || !isLiveShape(live)) throw new Error("unexpected shape");
    } catch {
      output.warn(`bunker: skipping #${q.number}, gh issue view returned unparseable output`);
      continue;
    }
    if (live.state !== "OPEN" || !hasQueuedLabel(live.labels)) continue;
    let waiting: number | undefined;
    await markTrust(live, cwd, env);
    for (const ref of blockerRefs(live)) {
      if ((await isDone(ref, cwd, env)) === false) {
        waiting = ref;
        break;
      }
    }
    if (waiting !== undefined) {
      output.warn(`bunker: #${q.number} waiting on #${waiting}`);
      continue;
    }
    if (!(await enforceLabeler(q.number, { cwd, env, ...(allowLabelers ? { allow: allowLabelers } : {}), onRefused: () => onRefused?.(q.number) }))) continue;
    counted++;
    const before = previous;
    let release!: () => void;
    previous = new Promise<void>((r) => (release = r));
    const task = work(q, index++, before, release).finally(() => active.delete(q.number));
    active.set(q.number, task);
  }
  await Promise.all(active.values());
  if (fatal) throw fatal.error;
  return done.filter((d): d is QueueEntry => d !== undefined);
}
