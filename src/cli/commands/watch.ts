import { liveGhEnv } from "../../github/identity.ts";
import { $ } from "bun";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { emit } from "../../core/events.ts";
import { addSpend, budgetSnapshot, DAY_MS, exceededCaps, formatSpend, type SpendCaps } from "../../core/spend.ts";
import { safePull } from "../../github/pull.ts";
import { clearStaleInProgress, runClean } from "./clean.ts";
import { codeSpan, redact } from "../../core/redact.ts";
import { failureReason, oneLine } from "../../core/reason.ts";
import { createStatusRecorder } from "./status.ts";
import pkg from "../../../package.json" with { type: "json" };
import { runAudit } from "../../pipeline/audit.ts";
import { runTriage } from "../../pipeline/triage.ts";
import type { Agent } from "../../agents/agent.ts";
import { listRecentPrOutcomes } from "../../github/prs.ts";
import { HISTORY_MS } from "./status.ts";
import { cleanMerged, createShepherd } from "../../pipeline/shepherd.ts";
import { runQueue, type QueueEntry, type QueueOptions } from "../../pipeline/queue.ts";
import { countWaiting } from "../../github/queue.ts";
import { latestBunkerLabeledAt } from "../../github/labeler.ts";
import { createCanceller, activeIssues } from "./cancel.ts";
import { markCancelled, takeCancelled, takeCancelRequests } from "../../core/cancel.ts";
import { IN_PROGRESS_LABEL, clearLanded, ensureLabel, releaseUnmergedReview, sweepClosedAwaitingReview, sweepClosedQueued, FAILED_LABEL, unqueue } from "../../github/labels.ts";
import { repoId } from "../../ui/ui.ts";
import { noNotify, withRepo, type Notify } from "../../core/notify.ts";

export interface WatchOptions extends Omit<QueueOptions, "merge" | "limit" | "keepGoing" | "shouldStop" | "skip" | "onResult" | "onRefused" | "handoff"> {
  /** Run the shepherd stage: a run ends when its PR is open and auto-merge armed, and every open bunker PR is kept green until it merges. Defaults to true. */
  shepherd?: boolean;
  /** How often the shepherd (and the waiting-PR reconcile) runs while a queue run is in flight. Defaults to 1 minute. */
  shepherdEveryMs?: number;
  /** Remove leftover worktrees and branches (as `bunker clean --yes`) once the lock is held. */
  cleanOnStart?: boolean;
  /** On start, stops agent containers left by a watcher that died; given the log function. */
  stopOrphans?: (log: (line: string) => void) => Promise<void>;
  /** With cleanOnStart: also prune run logs older than this many days. */
  logsDays?: number;
  /** Sleep between passes. Defaults to 10 minutes. */
  intervalMs?: number;
  /** Spend cap in notional USD per rolling 24 h. Defaults to no cap. */
  maxCostDayUsd?: number;
  /** Spend cap in notional USD per rolling 30 days. Defaults to no cap. */
  maxCostMonthUsd?: number;
  /** Re-reads the spend caps (global config, repo `[watch]`, flags) at the start of each pass and on SIGHUP, so a changed cap applies without a restart or interrupting a run. */
  reloadCaps?: () => Promise<SpendCaps>;
  /** Alias of `maxCostDayUsd`. */
  maxCostUsd?: number;
  /** Stop starting new issues after this long. Defaults to running until `signal` aborts. */
  forMs?: number;
  /** Kills the containers of one issue's run (`bunker cancel`). */
  stopIssue?: (issue: number) => void;
  /** Keeps one issue's worktree work as a stale tag and removes the worktree; returns the tag. */
  abandonIssue?: (issue: number) => Promise<string | undefined>;
  /** How often `.bunker/cancel` is checked for cancel requests. Defaults to 2 s. */
  cancelPollMs?: number;
  /** Abort to finish the current step and stop. */
  signal?: AbortSignal;
  /** `git pull --ff-only` the checkout before each pass (when clean, on the default branch). */
  pull?: boolean;
  /** Run `bunker audit` at most once per this many days (state in `.bunker/watch-state.json`). Off by default. */
  auditEveryDays?: number;
  /** Run `bunker triage` (comment and close only, never labelling) at most once per this many hours. Off by default. */
  triageEveryHours?: number;
  /** Agent for the periodic audit. Defaults to `agent`. */
  auditor?: Agent;
  /** Cap on issues the periodic audit files. Defaults to 5. */
  maxIssues?: number;
  /** One line per event. Defaults to console.log. */
  log?: (line: string) => void;
  /** Desktop notification for events that need the user. Defaults to none. */
  notify?: Notify;
}

export interface WatchSummary {
  passes: number;
  merged: number;
  /** Issues closed without a change: successes, neither failed nor merged. */
  noChange?: number;
  failed: number;
  spentUsd: number;
}

const HOUR_MS = 3_600_000;

/** `5h`, `90m`, `2h30m` as milliseconds; undefined for anything else (or zero). */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!m || (!m[1] && !m[2])) return undefined;
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
  return ms > 0 ? ms : undefined;
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes `.bunker/watch.lock`; a lock whose PID is dead is stale and taken over. */
function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      // Also released on process.exit (e.g. a second signal), not just on a clean stop.
      const release = () => {
        process.off("exit", release);
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file);
        } catch {}
      };
      process.on("exit", release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error(`another bunker watch is already running here (pid ${pid}, ${file})`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take ${file}`);
}

/**
 * Works the `bunker:queued` queue with auto-merge, pass after pass, until aborted or `forMs` is up.
 * Any outcome other than `merged` relabels the issue `bunker:failed` so it is never retried by itself.
 */
export async function runWatch({ intervalMs = 10 * 60_000, maxCostUsd, maxCostDayUsd = maxCostUsd, maxCostMonthUsd, reloadCaps, forMs, signal, pull = false, auditEveryDays, triageEveryHours, auditor, maxIssues, cleanOnStart, stopOrphans, logsDays, cancelPollMs = 2000, log = console.log, notify: rawNotify = noNotify, mention, shepherd: shepherdOn = true, shepherdEveryMs = 60_000, manual, ...opts }: WatchOptions): Promise<WatchSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const repo = (await $`git -C ${cwd} rev-parse --show-toplevel`.text()).trim();
  const notify = withRepo(rawNotify, (await repoId(repo)).split("/").pop()!);
  const gitCommonDir = (await $`git -C ${repo} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  const dir = join(repo, ".bunker");
  mkdirSync(dir, { recursive: true });
  const exclude = join(gitCommonDir, "info", "exclude");
  const excluded = (await Bun.file(exclude).exists()) ? await Bun.file(exclude).text() : "";
  const missing = ["/.bunker/watch.lock", "/.bunker/watch-spend.json", "/.bunker/watch-state.json", "/.bunker/watch-status.json"].filter((p) => !excluded.split("\n").includes(p));
  if (missing.length) await appendFile(exclude, `${excluded && !excluded.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  const release = acquireLock(join(dir, "watch.lock"));
  // Crash recovery, whether or not the worktree cleanup runs: the lock is ours, so no `bunker watch` run of ours is live.
  const stale = await clearStaleInProgress(repo, liveGhEnv());
  if (stale.length) log(`bunker: cleared a stale bunker:in-progress from ${stale.map((n) => `#${n}`).join(", ")}`);
  await stopOrphans?.(log);
  if (cleanOnStart) await runClean({ cwd: repo, yes: true, auto: true, ...(logsDays === undefined ? {} : { logsDays }) });

  let caps: SpendCaps = {
    ...(maxCostDayUsd === undefined ? {} : { day: maxCostDayUsd }),
    ...(maxCostMonthUsd === undefined ? {} : { month: maxCostMonthUsd }),
  };
  const status = createStatusRecorder(dir, { pid: process.pid, version: pkg.version, caps, parallel: opts.parallel ?? 1 }, (watcher) => emit(opts.onEvent, { type: "watcher", watcher }));
  signal?.addEventListener("abort", () => status.stopping(), { once: true });
  const cancelRun = createCanceller({
    active: () => activeIssues(status.snapshot().current),
    mark: markCancelled,
    stopContainers: (n) => opts.stopIssue?.(n),
    abandon: async (n) => opts.abandonIssue?.(n),
    unlabel: async (n) => void (await unqueue(n, cwd, env, ["--remove-label", IN_PROGRESS_LABEL])),
    comment: async (n, body) => void (await $`gh issue comment ${n} --body ${body}`.cwd(cwd).env(env).nothrow().quiet()),
    log,
  });
  const cancelTimer = setInterval(() => {
    for (const n of takeCancelRequests(repo)) void cancelRun(n).catch((e) => log(`bunker: could not cancel #${n}: ${e instanceof Error ? e.message : e}`));
  }, cancelPollMs);
  cancelTimer.unref?.();
  const userOnEvent = opts.onEvent;
  opts.onEvent = (e) => {
    status.event(e);
    userOnEvent?.(e);
  };

  const env = liveGhEnv();
  const spendFile = join(dir, "watch-spend.json");
  const deadline = forMs === undefined ? Infinity : Date.now() + forMs;
  const stopped = () => !!signal?.aborted || Date.now() >= deadline;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, Math.max(0, Math.min(ms, deadline - Date.now())));
      signal?.addEventListener("abort", done, { once: true });
      wake = done;
      function done() {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        if (wake === done) wake = undefined;
        resolve();
      }
    });

  const showCaps = (c: SpendCaps) => [c.day === undefined ? undefined : `$${c.day}/day`, c.month === undefined ? undefined : `$${c.month}/month`].filter(Boolean).join(", ") || "none";
  /** Swaps in freshly resolved caps; a failed read keeps the current ones. In-flight runs are untouched: only the next cap check sees them. */
  const refreshCaps = async () => {
    if (!reloadCaps) return;
    let next: SpendCaps;
    try {
      next = await reloadCaps();
    } catch (e) {
      log(`bunker: could not reload the spend caps, keeping the current ones: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (next.day === caps.day && next.month === caps.month) return;
    caps = next;
    status.setCaps(caps);
    log(`bunker: spend caps reloaded: ${showCaps(caps)}`);
    publishBudget();
  };
  const onHup = () => void refreshCaps().then(() => wake?.());
  if (reloadCaps) process.on("SIGHUP", onHup);
  const capped = () => exceededCaps(spendFile, caps);
  /** The spend against the caps, for the hub: exact costs only. */
  const publishBudget = () => emit(opts.onEvent, { type: "budget", budget: budgetSnapshot(spendFile, caps) });
  const record = (usd: number) => {
    addSpend(spendFile, usd);
    publishBudget();
  };

  const stateFile = join(dir, "watch-state.json");
  const readState = (): { lastAuditAt?: number; lastTriageAt?: number } => {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      return { ...(typeof raw?.lastAuditAt === "number" ? { lastAuditAt: raw.lastAuditAt } : {}), ...(typeof raw?.lastTriageAt === "number" ? { lastTriageAt: raw.lastTriageAt } : {}) };
    } catch {
      return {};
    }
  };
  const auditDue = () => auditEveryDays !== undefined && Date.now() - (readState().lastAuditAt ?? -Infinity) >= auditEveryDays * DAY_MS;
  const triageDue = () => triageEveryHours !== undefined && Date.now() - (readState().lastTriageAt ?? -Infinity) >= triageEveryHours * HOUR_MS;
  /** The periodic triage, comment-and-close only: queueing stays with a maintainer. Recorded as done even when it fails. */
  const triage = async () => {
    writeFileSync(stateFile, JSON.stringify({ ...readState(), lastTriageAt: Date.now() }));
    log("bunker: running the periodic triage");
    try {
      const r = await runTriage({ agent: auditor ?? opts.agent, sandbox: opts.sandbox, cwd, setup: opts.setup, mode: "comment", idleTimeoutMs: opts.idleTimeoutMs, completionTimeoutMs: opts.completionTimeoutMs, stepTimeoutMs: opts.stepTimeoutMs });
      if (r.usage?.costUsd) {
        record(r.usage.costUsd);
        summary.spentUsd += r.usage.costUsd;
      }
      log(`bunker: triage handled ${r.triaged.length} issue(s)${r.untouched.length ? `, ${r.untouched.length} left untouched` : ""}`);
    } catch (e) {
      log(`bunker: triage failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  /** The periodic audit. Recorded as done even when it fails, so a broken audit retries next period, not every pass. */
  const audit = async () => {
    writeFileSync(stateFile, JSON.stringify({ ...readState(), lastAuditAt: Date.now() }));
    log("bunker: running the periodic audit");
    try {
      const r = await runAudit({ agent: auditor ?? opts.agent, sandbox: opts.sandbox, cwd, setup: opts.setup, ...(maxIssues === undefined ? {} : { maxIssues }), idleTimeoutMs: opts.idleTimeoutMs, completionTimeoutMs: opts.completionTimeoutMs, stepTimeoutMs: opts.stepTimeoutMs });
      if (r.usage?.costUsd) {
        record(r.usage.costUsd);
        summary.spentUsd += r.usage.costUsd;
      }
      log(`bunker: audit filed ${r.filed.length} issue(s)${r.notFiled.length ? `, ${r.notFiled.length} not filed` : ""}`);
    } catch (e) {
      log(`bunker: audit failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  /** Issues this watcher gave up on (a failed relabel must not let one be retried) found already in progress (an open PR) or refused by the labeler check (e.g. a failed permission lookup); skipped for the rest of the run. */
  const handled = new Map<number, number>();
  const giveUp = (n: number) => void handled.set(n, Date.now());
  /** Skip a handled issue unless a human re-added `bunker:queued` since the watcher gave up on it (a label that predates that, e.g. after a failed relabel, doesn't count). */
  const skipHandled = async (n: number) => {
    const since = handled.get(n);
    if (since === undefined) return false;
    const labeledAt = await latestBunkerLabeledAt(n, { cwd, env });
    if (labeledAt === undefined || labeledAt <= since) return true;
    handled.delete(n);
    log(`bunker: #${n} relabelled; retrying`);
    return false;
  };
  let labelReady = false;
  const markFailed = async (e: QueueEntry) => {
    giveUp(e.issue);
    if (!labelReady) {
      await ensureLabel(FAILED_LABEL, cwd, env);
      labelReady = true;
    }
    const edit = await unqueue(e.issue, cwd, env, ["--add-label", FAILED_LABEL]);
    if (edit.exitCode !== 0) log(`bunker: could not relabel #${e.issue}: ${edit.stderr.toString().trim()}`);
    const reason = failureReason(e.status, e.logPath, { ...(e.error ? { error: e.error } : {}), ...(e.verifyOutput ? { verifyOutput: e.verifyOutput } : {}) });
    status.failed({ issue: e.issue, status: e.status, reason, ...(e.prUrl ? { prUrl: e.prUrl } : {}), ...(e.logPath ? { logPath: e.logPath } : {}) });
    notify(`bunker: #${e.issue} failed`, `${e.status}: ${reason}${e.prUrl ? ` · ${e.prUrl}` : ""}`);
    const body = redact([
      `${mention ? `${mention} ` : ""}bunker watch did not merge this issue: status \`${e.status}\`.`,
      "",
      `Reason: ${codeSpan(reason)}`,
      ...(e.error ? ["", "```", e.error.trimEnd(), "```"] : []),
      ...(e.verifyOutput ? ["", "Verify output:", "```", e.verifyOutput.trimEnd(), "```"] : []),
      ...(e.prUrl ? ["", `PR: ${e.prUrl}`] : []),
      ...(e.logPath ? ["", `Run log: \`${e.logPath}\``] : []),
      "",
      `Relabel \`bunker:queued\` to retry.`,
    ].join("\n"));
    await $`gh issue comment ${e.issue} --body ${body}`.cwd(cwd).env(env).nothrow().quiet();
  };

  const shepherd = shepherdOn ? createShepherd({ cwd, agent: opts.agent, ...(opts.reviewer ? { reviewer: opts.reviewer } : {}), sandbox: opts.sandbox, ...(opts.setup ? { setup: opts.setup } : {}), ...(opts.verify ? { verify: opts.verify } : {}), ...(opts.verifyOnHost ? { verifyOnHost: true } : {}), ...(opts.verifyNetwork ? { verifyNetwork: true } : {}), ...(opts.idleTimeoutMs ? { idleTimeoutMs: opts.idleTimeoutMs } : {}), ...(opts.completionTimeoutMs ? { completionTimeoutMs: opts.completionTimeoutMs } : {}), ...(opts.stepTimeoutMs ? { stepTimeoutMs: opts.stepTimeoutMs } : {}), ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), shouldStop: stopped, notify, ...(mention ? { mention } : {}) }) : undefined;
  const lastDecision = new Map<number, string>();
  let lastSweep = -Infinity;
  const SWEEP_EVERY_MS = 60 * 60_000;
  let reconcileDue = true;
  /**
   * Records PRs that merged or closed while no watcher saw them open (before a restart): the shepherd only reports the ones it watched
   * close, and a page replaying older history needs a merged/failed record to finish such a run.
   */
  const reconcileFinished = async () => {
    const outcomes = await listRecentPrOutcomes(cwd, env, Date.now() - HISTORY_MS);
    if (!outcomes) return;
    const known = status.snapshot();
    for (const o of outcomes) {
      if (known.merged.some((m) => m.issue === o.issue && m.at >= o.at)) continue;
      if (o.outcome === "merged") {
        status.merged({ issue: o.issue, prUrl: o.url, at: o.at });
      } else {
        if (known.failed.some((f) => f.issue === o.issue && f.at >= o.at) || known.merged.some((m) => m.issue === o.issue && m.at >= o.at)) continue;
        status.failed({ issue: o.issue, status: "closed-unmerged", reason: `PR #${o.pr} was closed without merging`, prUrl: o.url, at: o.at });
      }
    }
  };
  /**
   * A run that ended `awaiting-merge` stays in `current` until its PR is seen to settle, and the shepherd only reports PRs it watched
   * close. One batched lookup per pass settles every such entry: merged takes the in-run merge path, closed unmerged becomes failed.
   */
  const reconcileWaiting = async (): Promise<number> => {
    const waiting = new Set(status.snapshot().current.filter((c) => c.stage === "waiting for merge").map((c) => c.issue));
    if (!waiting.size) return 0;
    const outcomes = await listRecentPrOutcomes(cwd, env, Date.now() - HISTORY_MS);
    let landed = 0;
    for (const o of outcomes ?? []) {
      if (!waiting.has(o.issue)) continue;
      if (o.outcome === "merged") {
        landed++;
        summary.merged++;
        status.merged({ issue: o.issue, prUrl: o.url, at: o.at });
        emit(opts.onEvent, { type: "stage", issue: o.issue, name: "merged" });
        await clearLanded(o.issue, cwd, env);
        log(`bunker: shepherd: PR #${o.pr} merged`);
        notify(`bunker: PR #${o.pr} merged`, `#${o.issue} landed`);
      } else {
        const reason = `PR #${o.pr} was closed without merging`;
        summary.failed++;
        status.failed({ issue: o.issue, status: "closed-unmerged", reason, prUrl: o.url, at: o.at });
        emit(opts.onEvent, { type: "stage", issue: o.issue, name: "failed", text: "closed-unmerged", reason });
        log(`bunker: shepherd: ${reason}`);
        notify(`bunker: PR #${o.pr} closed unmerged`, reason);
      }
    }
    return landed;
  };
  /** One shepherd pass: resumes whatever the open PRs need, whether this watcher or an earlier one opened them. Returns how many merged. */
  const shepherdPass = async (): Promise<number> => {
    if (!shepherd || stopped()) return 0;
    // A PR that merged before this process saw it open (auto-merge, a restart) never reaches `p.merged`: on startup, then hourly, sweep
    // closed issues that kept their labels.
    if (Date.now() - lastSweep >= SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      for (const n of await sweepClosedQueued(cwd, env)) log(`bunker: cleared bunker:queued from closed #${n}`);
      for (const n of await sweepClosedAwaitingReview(cwd, env)) log(`bunker: cleared bunker:awaiting-review from closed #${n}`);
      const outcomes = await listRecentPrOutcomes(cwd, env, Date.now() - HISTORY_MS);
      const unmerged = new Set((outcomes ?? []).filter((o) => o.outcome !== "merged").map((o) => o.issue));
      for (const n of await releaseUnmergedReview(unmerged, cwd, env)) log(`bunker: #${n}'s PR closed unmerged: cleared bunker:awaiting-review (relabel bunker:queued to retry)`);
    }
    if (reconcileDue) {
      reconcileDue = false;
      await reconcileFinished();
    }
    const p = await shepherd.pass();
    if (p.error) log(`bunker: shepherd: ${p.error}`);
    if (p.usage?.costUsd) {
      record(p.usage.costUsd);
      summary.spentUsd += p.usage.costUsd;
    }
    status.shepherd(p.entries.map((e) => ({ issue: e.issue, pr: e.pr, prUrl: e.url, action: e.action, ...(e.detail ? { detail: e.detail.split("\n")[0]! } : {}) })));
    for (const e of p.entries) {
      // Quiet decisions (skipped, waiting, green) are logged when they change, so a stalled PR shows without a line per pass.
      const line = `bunker: shepherd: PR #${e.pr} ${e.action}${e.detail ? ` (${e.detail.split("\n")[0]})` : ""}`;
      if (["skipped", "waiting", "green"].includes(e.action) && lastDecision.get(e.pr) !== line) log(line);
      lastDecision.set(e.pr, line);
      if (e.action === "gave-up") {
        summary.failed++;
        status.failed({ issue: e.issue, status: "gave-up", reason: e.detail ?? "gave up", prUrl: e.url });
        emit(opts.onEvent, { type: "stage", issue: e.issue, name: "failed", text: "gave-up", reason: e.detail ?? "gave up" });
      }
      if (["fixed-ci", "updated-branch", "resolved-conflict", "addressed-review", "gave-up", "failed"].includes(e.action)) log(`bunker: shepherd: PR #${e.pr} ${e.action}${e.detail ? ` (${e.detail.split("\n")[0]})` : ""}`);
    }
    for (const c of p.closed) {
      const reason = `PR #${c.pr} was closed without merging`;
      summary.failed++;
      status.failed({ issue: c.issue, status: "closed-unmerged", reason, prUrl: c.url });
      emit(opts.onEvent, { type: "stage", issue: c.issue, name: "failed", text: "closed-unmerged", reason });
      log(`bunker: shepherd: ${reason}`);
      notify(`bunker: PR #${c.pr} closed unmerged`, reason);
    }
    let landed = 0;
    for (const m of p.merged) {
      if (m.unverified) {
        // Like the one-shot run: keep the worktree and branch for a human to look at.
        summary.failed++;
        status.failed({ issue: m.issue, status: "merge-unverified", reason: m.unverified, prUrl: m.url });
        emit(opts.onEvent, { type: "stage", issue: m.issue, name: "failed", text: "merge-unverified", reason: m.unverified });
        log(`bunker: shepherd: PR #${m.pr} ${m.unverified.split("\n")[0]}`);
        notify(`bunker: PR #${m.pr} merge unverified`, m.unverified);
        continue;
      }
      landed++;
      summary.merged++;
      status.merged({ issue: m.issue, prUrl: m.url });
      await clearLanded(m.issue, cwd, env);
      await cleanMerged(cwd, env, m.branch);
    }
    landed += await reconcileWaiting();
    if (p.paused) log(`bunker: shepherd: paused on the Claude usage limit${p.paused.resetAt ? ` until ${new Date(p.paused.resetAt).toISOString()}` : ""}`);
    return landed;
  };

  // Passes never overlap: the timer pass and the between-runs pass share one in-flight promise.
  let inFlight: Promise<number> | undefined;
  let unclaimed = 0;
  const guardedPass = (): Promise<number> => {
    inFlight ??= shepherdPass().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  /** While a queue run is in flight, keeps shepherding on a timer so merges and conflicts show up without waiting for the run to end. */
  const shepherdWhile = async <T>(work: Promise<T>): Promise<T> => {
    if (!shepherd) return work;
    const timer = setInterval(() => { void guardedPass().then((n) => { unclaimed += n; }, (e) => log(`bunker: shepherd: ${e instanceof Error ? e.message : String(e)}`)); }, shepherdEveryMs);
    try {
      return await work;
    } finally {
      clearInterval(timer);
      await inFlight?.catch(() => {});
    }
  };

  const summary: WatchSummary = { passes: 0, merged: 0, failed: 0, spentUsd: 0 };
  let idlePasses = 0;
  publishBudget();
  try {
    while (!stopped()) {
      await refreshCaps();
      const hit = capped();
      if (hit.length) {
        // Every exceeded window must free up before work resumes.
        const at = Math.max(...hit.map((h) => h.liftsAt));
        publishBudget();
        notify("bunker: spend cap reached", `${hit.map((h) => `${h.window === "day" ? "daily" : "monthly"} $${h.spent.toFixed(2)} of $${h.cap}`).join(", ")}; no new issues until ${new Date(at).toLocaleString()}`);
        for (const h of hit) log(`bunker: ${h.window === "day" ? "daily" : "monthly"} spend cap reached ($${h.spent.toFixed(2)} of $${h.cap} in ${h.window === "day" ? "24 h" : "30 days"}); no new issues, sleeping until ${new Date(at).toISOString()}`);
        // Re-check at least daily: a timer can't be that long.
        await sleep(Math.min(at - Date.now(), DAY_MS));
        continue;
      }
      if (pull) {
        const r = await safePull(cwd);
        if (!r.pulled) log(r.message);
      }
      if (auditDue() && !stopped()) await audit();
      if (triageDue() && !stopped()) await triage();
      let merged = 0;
      merged += await guardedPass();
      let pausedUntil: number | undefined;
      let paused = 0;
      const failedBefore = summary.failed;
      await shepherdWhile(runQueue({
        ...opts, ...(signal ? { signal } : {}), cwd, mention, merge: !manual, manual, handoff: shepherdOn && !manual, limit: Infinity, keepGoing: true, relist: true,
        skip: skipHandled,
        onRefused: giveUp,
        shouldStop: () => stopped() || capped().length > 0,
        onResult: async (e) => {
          // A cancelled run's result is not a failure; one that finished anyway keeps its own outcome.
          if (takeCancelled(e.issue) && !["merged", "no-change", "awaiting-merge", "awaiting-review", "needs-review", "pr-opened"].includes(e.status)) {
            giveUp(e.issue);
            status.event({ type: "stage", issue: e.issue, name: "done", at: Date.now() });
            return;
          }
          const usd = ((e.review?.usage ?? e.usage)?.costUsd ?? 0) + (e.priorCostUsd ?? 0);
          if (usd > 0) record(usd);
          summary.spentUsd += usd;
          if (e.status === "paused-usage-limit") {
            // Not a failure: the issue keeps `bunker:queued` and is resumed once the limit resets.
            paused = e.issue;
            pausedUntil = e.pause?.resetAt;
          } else if (e.status === "interrupted") {
            // Not a failure: a stop hit the run before it started; the issue keeps `bunker:queued`.
          } else if (e.status === "merged") {
            merged++;
            summary.merged++;
            status.merged({ issue: e.issue, ...(e.prUrl ? { prUrl: e.prUrl } : {}) });
            await clearLanded(e.issue, cwd, env);
          } else if (e.status === "no-change") {
            // A success: the issue is closed with an explained comment.
            summary.noChange = (summary.noChange ?? 0) + 1;
            const v = e.noChange;
            const reason = oneLine(v?.reason ?? "no change needed");
            status.noChange({ issue: e.issue, verdict: v?.verdict ?? "unknown", reason });
            notify(`bunker: #${e.issue} closed, no change needed`, `${v?.verdict ?? ""}: ${reason}`);
          } else if (e.status === "already-in-progress") {
            giveUp(e.issue);
          } else if (e.status === "awaiting-merge") {
            // Auto-merge is armed; the shepherd owns the PR from here.
            giveUp(e.issue);
          } else if (e.status === "awaiting-review") {
            giveUp(e.issue);
            notify(`bunker: #${e.issue} awaiting your review`, e.prUrl ?? e.error ?? "");
          } else if (e.status === "needs-review") {
            // Not a failure: the PR waits for a human, and the issue must not be picked up again.
            giveUp(e.issue);
            notify(`bunker: #${e.issue} needs human review`, e.prUrl ?? e.error ?? "");
          } else if (e.status === "blocked") {
            notify(`bunker: #${e.issue} blocked`, e.error ?? "waiting on another issue");
          } else {
            summary.failed++;
            await markFailed(e);
          }
        },
      }));
      merged += unclaimed;
      unclaimed = 0;
      summary.passes++;
      if (stopped()) {
        log(`bunker: pass ${summary.passes} · ${merged} merged · stopping · ${formatSpend(spendFile, caps)}`);
        break;
      }
      if (paused) {
        const wait = pausedUntil !== undefined ? Math.max(0, pausedUntil - Date.now()) : intervalMs;
        const until = new Date(Date.now() + wait).toISOString();
        notify("bunker: paused on the Claude usage limit", `#${paused} resumes ${new Date(Date.now() + wait).toLocaleString()}`);
        log(`bunker: Claude usage limit reached on #${paused}; paused, sleeping until ${until}${pausedUntil === undefined ? " (no reset time given; using --interval)" : ""}, then resuming the same issue`);
        await sleep(wait);
        if (!stopped()) {
          log(`bunker: resuming #${paused} after the usage limit`);
          notify("bunker: resumed after the usage limit", `#${paused}`);
        }
        continue;
      }
      if (merged > 0) notify(`bunker: pass ${summary.passes} · ${merged} merged`, `${summary.merged} merged so far · $${summary.spentUsd.toFixed(2)} spent`);
      const progressed = merged > 0 || summary.failed > failedBefore;
      idlePasses = progressed ? 0 : idlePasses + 1;
      // Two passes in a row that merged and failed nothing (everything skipped) would spin; sleep instead.
      const waiting = idlePasses >= 2 || capped().length > 0 ? 0 : await countWaiting(cwd, env, skipHandled);
      if (waiting > 0) {
        log(`bunker: pass ${summary.passes} · ${merged} merged · next pass now (${waiting} waiting) · ${formatSpend(spendFile, caps)}`);
        continue;
      }
      const mins = intervalMs / 60_000;
      log(`bunker: pass ${summary.passes} · ${merged} merged · next pass in ${Number.isInteger(mins) ? mins : mins.toFixed(2)} min · ${formatSpend(spendFile, caps)}`);
      status.nextPass(Date.now() + intervalMs);
      await sleep(intervalMs);
      status.nextPass(undefined);
    }
  } catch (e) {
    notify("bunker: watch crashed", e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    clearInterval(cancelTimer);
    process.off("SIGHUP", onHup);
    release();
  }
  notify("bunker: watch stopped", `${summary.passes} pass(es) · ${summary.merged} merged · ${summary.failed} failed`);
  log(`bunker: watch stopped after ${summary.passes} pass(es) · ${summary.merged} merged · ${summary.failed} failed · $${summary.spentUsd.toFixed(2)} spent`);
  return summary;
}
