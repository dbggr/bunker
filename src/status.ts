import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS, MONTH_MS, spentWithin, type SpendCaps } from "./spend.ts";
import { orderQueue, priorityRank, PRIORITY_LABELS, isBug, type Queued } from "./priority.ts";
import type { BunkerEvent } from "./events.ts";

export const STATUS_FILE = "watch-status.json";
export const LOCK_FILE = "watch.lock";

export interface CurrentRun {
  issue: number;
  stage: string;
  /** Epoch ms the run entered `stage`. */
  since: number;
  logPath?: string;
}

export interface MergedRun {
  issue: number;
  prUrl?: string;
  at: number;
}

export interface FailedRun {
  issue: number;
  status: string;
  /** One line, redacted. */
  reason: string;
  prUrl?: string;
  logPath?: string;
  at: number;
}

/** What a running (or last-run) `--watch` leaves in `.bunker/watch-status.json`. */
export interface WatchStatusFile {
  pid: number;
  version: string;
  startedAt: number;
  current: CurrentRun[];
  merged: MergedRun[];
  failed: FailedRun[];
}

/** Keeps the status file current for a watcher; every change is written straight away. */
export function createStatusRecorder(dir: string, init: { pid: number; version: string }) {
  const file = join(dir, STATUS_FILE);
  const state: WatchStatusFile = { ...init, startedAt: Date.now(), current: [], merged: [], failed: [] };
  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(state));
    } catch {}
  };
  save();
  return {
    /** Feed every run event through here. */
    event(e: BunkerEvent) {
      if (e.issue === undefined) return;
      const i = state.current.findIndex((c) => c.issue === e.issue);
      if (e.type === "meta" && e.logPath && i >= 0) state.current[i]!.logPath = e.logPath;
      else if (e.type === "meta" && e.logPath) state.current.push({ issue: e.issue, stage: "setup", since: e.at, logPath: e.logPath });
      else if (e.type === "stage" && e.name) {
        if (e.name === "merged" || e.name === "failed" || e.name === "done") {
          if (i >= 0) state.current.splice(i, 1);
        } else if (i < 0) state.current.push({ issue: e.issue, stage: e.name, since: e.at });
        else if (state.current[i]!.stage !== e.name) Object.assign(state.current[i]!, { stage: e.name, since: e.at });
        else return;
      } else return;
      save();
    },
    merged(r: Omit<MergedRun, "at">) {
      state.merged.push({ ...r, at: Date.now() });
      save();
    },
    failed(r: Omit<FailedRun, "at">) {
      state.failed = state.failed.filter((f) => f.issue !== r.issue);
      state.failed.push({ ...r, at: Date.now() });
      save();
    },
  };
}

export const retryCommand = (n: number) => `gh issue edit ${n} --remove-label bunker-failed --add-label bunker`;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readStatusFile(dir: string): WatchStatusFile | undefined {
  const raw = readJson(join(dir, STATUS_FILE)) as Partial<WatchStatusFile> | undefined;
  if (!raw || typeof raw.pid !== "number" || typeof raw.startedAt !== "number") return undefined;
  return {
    pid: raw.pid,
    version: typeof raw.version === "string" ? raw.version : "unknown",
    startedAt: raw.startedAt,
    current: Array.isArray(raw.current) ? raw.current : [],
    merged: Array.isArray(raw.merged) ? raw.merged : [],
    failed: Array.isArray(raw.failed) ? raw.failed : [],
  };
}

export interface StatusReport {
  watcher: {
    alive: boolean;
    /** The lock names a PID that is gone. */
    stale: boolean;
    pid?: number;
    version?: string;
    startedAt?: number;
    uptimeMs?: number;
  };
  /** Runs in flight; empty when the watcher is not alive. */
  current: { issue: number; stage: string; sinceMs: number; logPath?: string }[];
  /** Open `bunker` issues in priority order; null when GitHub could not be asked. */
  queue: { number: number; title: string; priority: string; bug: boolean }[] | null;
  merged: MergedRun[];
  failed: (FailedRun & { retry: string })[];
  spend: { day: { spentUsd: number; capUsd?: number }; month: { spentUsd: number; capUsd?: number } };
}

export interface StatusOptions {
  /** The repo root (where `.bunker/` is). */
  repo: string;
  caps?: SpendCaps;
  /** The open `bunker` issues, unordered; undefined when unavailable. */
  queue?: () => Promise<Queued[] | undefined>;
  alive: (pid: number) => boolean;
  now?: number;
}

/** Read-only snapshot of the watcher, its runs, the queue and the spend. */
export async function collectStatus({ repo, caps = {}, queue, alive, now = Date.now() }: StatusOptions): Promise<StatusReport> {
  const dir = join(repo, ".bunker");
  let lockPid: number | undefined;
  try {
    const n = Number(readFileSync(join(dir, LOCK_FILE), "utf8").trim());
    if (Number.isInteger(n) && n > 0) lockPid = n;
  } catch {}
  const isAlive = lockPid !== undefined && alive(lockPid);
  const file = readStatusFile(dir);
  const mine = file;
  const pid = lockPid ?? mine?.pid;
  const watcher: StatusReport["watcher"] = {
    alive: isAlive,
    stale: lockPid !== undefined && !isAlive,
    ...(pid === undefined ? {} : { pid }),
    ...(mine ? { version: mine.version, startedAt: mine.startedAt, ...(isAlive ? { uptimeMs: now - mine.startedAt } : {}) } : {}),
  };
  const queued = queue ? await queue().catch(() => undefined) : undefined;
  const spendFile = join(dir, "watch-spend.json");
  const spend = (ms: number, cap?: number) => ({ spentUsd: spentWithin(spendFile, ms), ...(cap === undefined ? {} : { capUsd: cap }) });
  return {
    watcher,
    current: isAlive && mine ? mine.current.map((c) => ({ issue: c.issue, stage: c.stage, sinceMs: now - c.since, ...(c.logPath ? { logPath: c.logPath } : {}) })) : [],
    queue: queued
      ? orderQueue(queued).map((q) => ({
          number: q.number,
          title: q.title,
          priority: PRIORITY_LABELS.find((p) => p.rank === priorityRank(q.labels))?.short ?? "none",
          bug: isBug(q.labels),
        }))
      : null,
    merged: mine?.merged ?? [],
    failed: (mine?.failed ?? []).map((f) => ({ ...f, retry: retryCommand(f.issue) })),
    spend: { day: spend(DAY_MS, caps.day), month: spend(MONTH_MS, caps.month) },
  };
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

export function formatStatus(r: StatusReport): string {
  const out: string[] = [];
  const w = r.watcher;
  if (w.alive) out.push(`watcher: alive · pid ${w.pid} · ${w.version ?? "unknown version"} · up ${duration(w.uptimeMs ?? 0)}`);
  else out.push(`watcher: not running${w.stale ? ` (stale lock, pid ${w.pid} is gone)` : ""}${w.startedAt ? ` · last run started ${new Date(w.startedAt).toISOString()}${w.version ? ` · ${w.version}` : ""}` : ""}`);
  out.push("", "current run:");
  if (r.current.length) for (const c of r.current) out.push(`  #${c.issue} · ${c.stage} for ${duration(c.sinceMs)}`);
  else out.push("  none");
  out.push("", "queue:");
  if (r.queue === null) out.push("  unavailable (gh could not list issues)");
  else if (!r.queue.length) out.push("  empty");
  else r.queue.forEach((q, i) => out.push(`  ${i + 1}. #${q.number} ${q.title}${q.priority !== "none" || q.bug ? ` (${[q.priority !== "none" ? q.priority : "", q.bug ? "bug" : ""].filter(Boolean).join(", ")})` : ""}`));
  out.push("", `merged${w.alive ? " since the watcher started" : " in the last run"}: ${r.merged.length}`);
  for (const m of r.merged) out.push(`  #${m.issue}${m.prUrl ? ` · ${m.prUrl}` : ""}`);
  out.push("", `failed: ${r.failed.length}`);
  for (const f of r.failed) {
    out.push(`  #${f.issue} ${f.status}: ${f.reason}`, `    ${f.prUrl ?? f.logPath ?? "no PR or log"}`, `    retry: ${f.retry}`);
  }
  const usd = (x: { spentUsd: number; capUsd?: number }) => `$${x.spentUsd.toFixed(2)}${x.capUsd === undefined ? " (no cap)" : ` of $${x.capUsd}`}`;
  out.push("", `spend: ${usd(r.spend.day)} in 24 h · ${usd(r.spend.month)} in 30 days`);
  return out.join("\n");
}

