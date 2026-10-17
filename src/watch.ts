import { $ } from "bun";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { safePull } from "./pull.ts";
import { redact } from "./redact.ts";
import { runAudit } from "./audit.ts";
import type { Agent } from "./index.ts";
import { countWaiting, runQueue, type QueueEntry, type QueueOptions } from "./issue.ts";

export interface WatchOptions extends Omit<QueueOptions, "merge" | "limit" | "keepGoing" | "shouldStop" | "skip" | "onResult"> {
  /** Sleep between passes. Defaults to 10 minutes. */
  intervalMs?: number;
  /** Spend cap in USD per rolling 24 h. Defaults to 20. */
  maxCostUsd?: number;
  /** Stop starting new issues after this long. Defaults to running until `signal` aborts. */
  forMs?: number;
  /** Abort to finish the current step and stop. */
  signal?: AbortSignal;
  /** `git pull --ff-only` the checkout before each pass (when clean, on the default branch). */
  pull?: boolean;
  /** Run `--audit` at most once per this many days (state in `.bunker/watch-state.json`). Off by default. */
  auditEveryDays?: number;
  /** Agent for the periodic audit. Defaults to `agent`. */
  auditor?: Agent;
  /** Cap on issues the periodic audit files. Defaults to 5. */
  maxIssues?: number;
  /** One line per event. Defaults to console.log. */
  log?: (line: string) => void;
}

export interface WatchSummary {
  passes: number;
  merged: number;
  failed: number;
  spentUsd: number;
}

const DAY_MS = 24 * 3_600_000;
export const FAILED_LABEL = "bunker-failed";

/** `5h`, `90m`, `2h30m` as milliseconds; undefined for anything else (or zero). */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!m || (!m[1] && !m[2])) return undefined;
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
  return ms > 0 ? ms : undefined;
}

interface Spend {
  at: number;
  usd: number;
}

function readSpend(file: string): Spend[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw.filter((e) => typeof e?.at === "number" && typeof e?.usd === "number") : [];
  } catch {
    return [];
  }
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
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error(`another bunker --watch is already running here (pid ${pid}, ${file})`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take ${file}`);
}

/**
 * Works the `bunker` queue with auto-merge, pass after pass, until aborted or `forMs` is up.
 * Any outcome other than `merged` relabels the issue `bunker-failed` so it is never retried by itself.
 */
export async function runWatch({ intervalMs = 10 * 60_000, maxCostUsd = 20, forMs, signal, pull = false, auditEveryDays, auditor, maxIssues, log = console.log, ...opts }: WatchOptions): Promise<WatchSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const repo = (await $`git -C ${cwd} rev-parse --show-toplevel`.text()).trim();
  const gitCommonDir = (await $`git -C ${repo} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  const dir = join(repo, ".bunker");
  mkdirSync(dir, { recursive: true });
  const exclude = join(gitCommonDir, "info", "exclude");
  const excluded = (await Bun.file(exclude).exists()) ? await Bun.file(exclude).text() : "";
  const missing = ["/.bunker/watch.lock", "/.bunker/watch-spend.json", "/.bunker/watch-state.json"].filter((p) => !excluded.split("\n").includes(p));
  if (missing.length) await appendFile(exclude, `${excluded && !excluded.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  const release = acquireLock(join(dir, "watch.lock"));

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

  const spentNow = () => readSpend(spendFile).filter((e) => e.at > Date.now() - DAY_MS).reduce((a, e) => a + e.usd, 0);
  /** When the oldest spend leaves the window far enough for spending to resume. */
  const capLiftsAt = () => {
    const entries = readSpend(spendFile).filter((e) => e.at > Date.now() - DAY_MS).sort((a, b) => a.at - b.at);
    let total = entries.reduce((a, e) => a + e.usd, 0);
    for (const e of entries) {
      total -= e.usd;
      if (total < maxCostUsd) return e.at + DAY_MS;
    }
    return Date.now();
  };
  const addSpend = (usd: number) => {
    const entries = readSpend(spendFile).filter((e) => e.at > Date.now() - DAY_MS);
    writeFileSync(spendFile, JSON.stringify([...entries, { at: Date.now(), usd }]));
  };

  const stateFile = join(dir, "watch-state.json");
  const readState = (): { lastAuditAt?: number } => {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      return raw && typeof raw.lastAuditAt === "number" ? { lastAuditAt: raw.lastAuditAt } : {};
    } catch {
      return {};
    }
  };
  const auditDue = () => auditEveryDays !== undefined && Date.now() - (readState().lastAuditAt ?? -Infinity) >= auditEveryDays * DAY_MS;
  /** The periodic audit. Recorded as done even when it fails, so a broken audit retries next period, not every pass. */
  const audit = async () => {
    writeFileSync(stateFile, JSON.stringify({ ...readState(), lastAuditAt: Date.now() }));
    log("bunker: running the periodic audit");
    try {
      const r = await runAudit({ agent: auditor ?? opts.agent, sandbox: opts.sandbox, cwd, setup: opts.setup, ...(maxIssues === undefined ? {} : { maxIssues }), idleTimeoutMs: opts.idleTimeoutMs, completionTimeoutMs: opts.completionTimeoutMs, stepTimeoutMs: opts.stepTimeoutMs });
      if (r.usage?.costUsd) {
        addSpend(r.usage.costUsd);
        summary.spentUsd += r.usage.costUsd;
      }
      log(`bunker: audit filed ${r.filed.length} issue(s)${r.notFiled.length ? `, ${r.notFiled.length} not filed` : ""}`);
    } catch (e) {
      log(`bunker: audit failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  /** Issues this watcher already gave up on; a failed relabel must not let one be retried. */
  const handled = new Set<number>();
  let labelReady = false;
  const markFailed = async (e: QueueEntry) => {
    handled.add(e.issue);
    if (!labelReady) {
      await $`gh label create ${FAILED_LABEL} --description ${"bunker gave up on this issue; relabel `bunker` to retry"} --color B60205`.cwd(cwd).env(env).nothrow().quiet();
      labelReady = true;
    }
    const edit = await $`gh issue edit ${e.issue} --remove-label bunker --add-label ${FAILED_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
    if (edit.exitCode !== 0) log(`bunker: could not relabel #${e.issue}: ${edit.stderr.toString().trim()}`);
    const body = redact([
      `bunker --watch did not merge this issue: status \`${e.status}\`.`,
      ...(e.error ? ["", "```", e.error.trimEnd(), "```"] : []),
      ...(e.verifyOutput ? ["", "Verify output:", "```", e.verifyOutput.trimEnd(), "```"] : []),
      ...(e.prUrl ? ["", `PR: ${e.prUrl}`] : []),
      ...(e.logPath ? ["", `Run log: \`${e.logPath}\``] : []),
      "",
      `Relabel \`bunker\` to retry.`,
    ].join("\n"));
    await $`gh issue comment ${e.issue} --body ${body}`.cwd(cwd).env(env).nothrow().quiet();
  };

  const summary: WatchSummary = { passes: 0, merged: 0, failed: 0, spentUsd: 0 };
  let idlePasses = 0;
  try {
    while (!stopped()) {
      if (spentNow() >= maxCostUsd) {
        const at = capLiftsAt();
        log(`bunker: spend cap reached ($${spentNow().toFixed(2)} of $${maxCostUsd} in 24 h); sleeping until ${new Date(at).toISOString()}`);
        await sleep(at - Date.now());
        continue;
      }
      if (pull) {
        const r = await safePull(cwd);
        if (!r.pulled) log(r.message);
      }
      if (auditDue() && !stopped()) await audit();
      let merged = 0;
      let pausedUntil: number | undefined;
      let paused = 0;
      const failedBefore = summary.failed;
      await runQueue({
        ...opts, cwd, merge: true, limit: Infinity, keepGoing: true, relist: true,
        skip: (n) => handled.has(n),
        shouldStop: () => stopped() || spentNow() >= maxCostUsd,
        onResult: async (e) => {
          const usd = ((e.review?.usage ?? e.usage)?.costUsd ?? 0) + (e.priorCostUsd ?? 0);
          if (usd > 0) addSpend(usd);
          summary.spentUsd += usd;
          if (e.status === "paused-usage-limit") {
            // Not a failure: the issue keeps `bunker` and is resumed once the limit resets.
            paused = e.issue;
            pausedUntil = e.pause?.resetAt;
          } else if (e.status === "merged") {
            merged++;
            summary.merged++;
          } else if (e.status !== "blocked" && e.status !== "already-in-progress") {
            summary.failed++;
            await markFailed(e);
          }
        },
      });
      summary.passes++;
      if (stopped()) break;
      if (paused) {
        const wait = pausedUntil !== undefined ? Math.max(0, pausedUntil - Date.now()) : intervalMs;
        const until = new Date(Date.now() + wait).toISOString();
        log(`bunker: Claude usage limit reached on #${paused}; paused, sleeping until ${until}${pausedUntil === undefined ? " (no reset time given; using --interval)" : ""}, then resuming the same issue`);
        await sleep(wait);
        if (!stopped()) log(`bunker: resuming #${paused} after the usage limit`);
        continue;
      }
      const progressed = merged > 0 || summary.failed > failedBefore;
      idlePasses = progressed ? 0 : idlePasses + 1;
      // Two passes in a row that merged and failed nothing (everything skipped) would spin; sleep instead.
      const waiting = idlePasses >= 2 || spentNow() >= maxCostUsd ? 0 : await countWaiting(cwd, env, (n) => handled.has(n));
      if (waiting > 0) {
        log(`bunker: pass ${summary.passes} · ${merged} merged · next pass now (${waiting} waiting)`);
        continue;
      }
      const mins = intervalMs / 60_000;
      log(`bunker: pass ${summary.passes} · ${merged} merged · next pass in ${Number.isInteger(mins) ? mins : mins.toFixed(2)} min`);
      await sleep(intervalMs);
    }
  } finally {
    release();
  }
  log(`bunker: watch stopped after ${summary.passes} pass(es) · ${summary.merged} merged · ${summary.failed} failed · $${summary.spentUsd.toFixed(2)} spent`);
  return summary;
}
