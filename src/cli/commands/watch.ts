import { $ } from "bun";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { addSpend, DAY_MS, exceededCaps, formatSpend, type SpendCaps } from "../../core/spend.ts";
import { safePull } from "../../github/pull.ts";
import { clearStaleInProgress, runClean } from "./clean.ts";
import { codeSpan, redact } from "../../core/redact.ts";
import { failureReason } from "../../core/reason.ts";
import { createStatusRecorder } from "./status.ts";
import pkg from "../../../package.json" with { type: "json" };
import { runAudit } from "../../pipeline/audit.ts";
import { runTriage } from "../../pipeline/triage.ts";
import type { Agent } from "../../agents/agent.ts";
import { cleanMerged, createShepherd } from "../../pipeline/shepherd.ts";
import { runQueue, type QueueEntry, type QueueOptions } from "../../pipeline/queue.ts";
import { countWaiting } from "../../github/queue.ts";
import { latestBunkerLabeledAt } from "../../github/labeler.ts";
import { ensureLabel, FAILED_LABEL, unqueue } from "../../github/labels.ts";
import { noNotify, type Notify } from "../../core/notify.ts";

export interface WatchOptions extends Omit<QueueOptions, "merge" | "limit" | "keepGoing" | "shouldStop" | "skip" | "onResult" | "onRefused" | "handoff"> {
  /** Run the shepherd stage: a run ends when its PR is open and auto-merge armed, and every open bunker PR is kept green until it merges. Defaults to true. */
  shepherd?: boolean;
  /** Remove leftover worktrees and branches (as `bunker clean --yes`) once the lock is held. */
  cleanOnStart?: boolean;
  /** With cleanOnStart: also prune run logs older than this many days. */
  logsDays?: number;
  /** Sleep between passes. Defaults to 10 minutes. */
  intervalMs?: number;
  /** Spend cap in notional USD per rolling 24 h. Defaults to no cap. */
  maxCostDayUsd?: number;
  /** Spend cap in notional USD per rolling 30 days. Defaults to no cap. */
  maxCostMonthUsd?: number;
  /** Alias of `maxCostDayUsd`. */
  maxCostUsd?: number;
  /** Stop starting new issues after this long. Defaults to running until `signal` aborts. */
  forMs?: number;
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
export async function runWatch({ intervalMs = 10 * 60_000, maxCostUsd, maxCostDayUsd = maxCostUsd, maxCostMonthUsd, forMs, signal, pull = false, auditEveryDays, triageEveryHours, auditor, maxIssues, cleanOnStart, logsDays, log = console.log, notify = noNotify, mention, shepherd: shepherdOn = true, manual, ...opts }: WatchOptions): Promise<WatchSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const repo = (await $`git -C ${cwd} rev-parse --show-toplevel`.text()).trim();
  const gitCommonDir = (await $`git -C ${repo} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  const dir = join(repo, ".bunker");
  mkdirSync(dir, { recursive: true });
  const exclude = join(gitCommonDir, "info", "exclude");
  const excluded = (await Bun.file(exclude).exists()) ? await Bun.file(exclude).text() : "";
  const missing = ["/.bunker/watch.lock", "/.bunker/watch-spend.json", "/.bunker/watch-state.json", "/.bunker/watch-status.json"].filter((p) => !excluded.split("\n").includes(p));
  if (missing.length) await appendFile(exclude, `${excluded && !excluded.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  const release = acquireLock(join(dir, "watch.lock"));
  // Crash recovery, whether or not the worktree cleanup runs: the lock is ours, so no `bunker watch` run of ours is live.
  const stale = await clearStaleInProgress(repo, (process.env.BUNKER_GH_TOKEN ? { ...process.env, GH_TOKEN: process.env.BUNKER_GH_TOKEN } : process.env) as Record<string, string>);
  if (stale.length) log(`bunker: cleared a stale bunker:in-progress from ${stale.map((n) => `#${n}`).join(", ")}`);
  if (cleanOnStart) await runClean({ cwd: repo, yes: true, auto: true, ...(logsDays === undefined ? {} : { logsDays }) });

  const status = createStatusRecorder(dir, { pid: process.pid, version: pkg.version });
  const userOnEvent = opts.onEvent;
  opts.onEvent = (e) => {
    status.event(e);
    userOnEvent?.(e);
  };

  const token = process.env.BUNKER_GH_TOKEN;
  const env = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
  const spendFile = join(dir, "watch-spend.json");
  const deadline = forMs === undefined ? Infinity : Date.now() + forMs;
  const stopped = () => !!signal?.aborted || Date.now() >= deadline;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, Math.max(0, Math.min(ms, deadline - Date.now())));
      signal?.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      }
    });

  const caps: SpendCaps = {
    ...(maxCostDayUsd === undefined ? {} : { day: maxCostDayUsd }),
    ...(maxCostMonthUsd === undefined ? {} : { month: maxCostMonthUsd }),
  };
  const capped = () => exceededCaps(spendFile, caps);
  const record = (usd: number) => addSpend(spendFile, usd);

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

  const shepherd = shepherdOn ? createShepherd({ cwd, agent: opts.agent, ...(opts.reviewer ? { reviewer: opts.reviewer } : {}), sandbox: opts.sandbox, ...(opts.setup ? { setup: opts.setup } : {}), ...(opts.verify ? { verify: opts.verify } : {}), ...(opts.verifyOnHost ? { verifyOnHost: true } : {}), ...(opts.verifyNetwork ? { verifyNetwork: true } : {}), ...(opts.idleTimeoutMs ? { idleTimeoutMs: opts.idleTimeoutMs } : {}), ...(opts.completionTimeoutMs ? { completionTimeoutMs: opts.completionTimeoutMs } : {}), ...(opts.stepTimeoutMs ? { stepTimeoutMs: opts.stepTimeoutMs } : {}), ...(opts.onEvent ? { onEvent: opts.onEvent } : {}), notify, ...(mention ? { mention } : {}) }) : undefined;
  /** One shepherd pass: resumes whatever the open PRs need, whether this watcher or an earlier one opened them. Returns how many merged. */
  const shepherdPass = async (): Promise<number> => {
    if (!shepherd || stopped()) return 0;
    const p = await shepherd.pass();
    if (p.error) log(`bunker: shepherd: ${p.error}`);
    if (p.usage?.costUsd) {
      record(p.usage.costUsd);
      summary.spentUsd += p.usage.costUsd;
    }
    for (const e of p.entries) {
      if (e.action === "gave-up") {
        summary.failed++;
        status.failed({ issue: e.issue, status: "gave-up", reason: e.detail ?? "gave up", prUrl: e.url });
      }
      if (["fixed-ci", "updated-branch", "resolved-conflict", "addressed-review", "gave-up", "failed"].includes(e.action)) log(`bunker: shepherd: PR #${e.pr} ${e.action}${e.detail ? ` (${e.detail.split("\n")[0]})` : ""}`);
    }
    for (const m of p.merged) {
      summary.merged++;
      status.merged({ issue: m.issue, prUrl: m.url });
      await cleanMerged(cwd, env, m.branch);
    }
    if (p.paused) log(`bunker: shepherd: paused on the Claude usage limit${p.paused.resetAt ? ` until ${new Date(p.paused.resetAt).toISOString()}` : ""}`);
    return p.merged.length;
  };

  const summary: WatchSummary = { passes: 0, merged: 0, failed: 0, spentUsd: 0 };
  let idlePasses = 0;
  try {
    while (!stopped()) {
      const hit = capped();
      if (hit.length) {
        // Every exceeded window must free up before work resumes.
        const at = Math.max(...hit.map((h) => h.liftsAt));
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
      merged += await shepherdPass();
      let pausedUntil: number | undefined;
      let paused = 0;
      const failedBefore = summary.failed;
      await runQueue({
        ...opts, cwd, mention, merge: !manual, manual, handoff: shepherdOn && !manual, limit: Infinity, keepGoing: true, relist: true,
        skip: skipHandled,
        onRefused: giveUp,
        shouldStop: () => stopped() || capped().length > 0,
        onResult: async (e) => {
          const usd = ((e.review?.usage ?? e.usage)?.costUsd ?? 0) + (e.priorCostUsd ?? 0);
          if (usd > 0) record(usd);
          summary.spentUsd += usd;
          if (e.status === "paused-usage-limit") {
            // Not a failure: the issue keeps `bunker:queued` and is resumed once the limit resets.
            paused = e.issue;
            pausedUntil = e.pause?.resetAt;
          } else if (e.status === "merged") {
            merged++;
            summary.merged++;
            status.merged({ issue: e.issue, ...(e.prUrl ? { prUrl: e.prUrl } : {}) });
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
      });
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
      await sleep(intervalMs);
    }
  } catch (e) {
    notify("bunker: watch crashed", e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    release();
  }
  notify("bunker: watch stopped", `${summary.passes} pass(es) · ${summary.merged} merged · ${summary.failed} failed`);
  log(`bunker: watch stopped after ${summary.passes} pass(es) · ${summary.merged} merged · ${summary.failed} failed · $${summary.spentUsd.toFixed(2)} spent`);
  return summary;
}
