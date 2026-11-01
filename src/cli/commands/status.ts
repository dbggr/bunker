import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY_MS, MONTH_MS, spentWithin, type SpendCaps } from "../../core/spend.ts";
import { orderQueue, priorityRank, PRIORITY_LABELS, isBug, type Queued } from "../../core/priority.ts";
import type { BunkerEvent, WatcherInfo } from "../../core/events.ts";

export const STATUS_FILE = "watch-status.json";
export const LOCK_FILE = "watch.lock";
/** How long finished runs stay in the status file (the hub's history age limit). */
export const HISTORY_MS = 7 * DAY_MS;

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

/** An issue bunker closed without a change; not a failure and not a merge. */
export interface NoChangeRun {
  issue: number;
  verdict: string;
  /** One line, redacted. */
  reason: string;
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

/** The shepherd's latest decision on an open bunker PR. */
export interface ShepherdRun {
  issue: number;
  pr: number;
  prUrl?: string;
  action: string;
  /** One line, redacted. */
  detail?: string;
}

/** What a running (or last-run) `bunker watch` leaves in `.bunker/watch-status.json`. */
export interface WatchStatusFile {
  pid: number;
  version: string;
  startedAt: number;
  /** The spend caps the watcher is running with (flags over config). */
  caps?: SpendCaps;
  current: CurrentRun[];
  merged: MergedRun[];
  noChange: NoChangeRun[];
  failed: FailedRun[];
  /** The last shepherd decision per open bunker PR. */
  shepherd: (ShepherdRun & { at: number })[];
}

/** Keeps the status file current for a watcher; every change is written straight away. */
export function createStatusRecorder(dir: string, init: { pid: number; version: string; caps?: SpendCaps; parallel?: number }, onChange?: (watcher: WatcherInfo) => void) {
  const file = join(dir, STATUS_FILE);
  const { parallel = 1, ...fileInit } = init;
  let nextPassAt: number | undefined;
  let stopping = false;
  // Issues whose PR merged after their run last reported: a late "waiting for merge" from that run must not bring it back.
  const landed = new Set<number>();
  // Finished runs are kept across restarts for the history window, so a page replaying older history can still finish them.
  const kept = readStatusFile(dir);
  const since = Date.now() - HISTORY_MS;
  const recent = <T extends { at: number }>(xs: T[] | undefined): T[] => (xs ?? []).filter((x) => typeof x?.at === "number" && x.at >= since);
  const state: WatchStatusFile = { ...fileInit, startedAt: Date.now(), current: [], merged: recent(kept?.merged), noChange: recent(kept?.noChange), failed: recent(kept?.failed), shepherd: [] };
  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(state));
    } catch {}
    try {
      onChange?.({ pid: state.pid, version: state.version, startedAt: state.startedAt, parallel, ...(stopping ? { stopping } : {}), ...(nextPassAt === undefined ? {} : { nextPassAt }), ...structuredClone({ merged: state.merged, noChange: state.noChange, failed: state.failed, shepherd: state.shepherd }) });
    } catch {}
  };
  save();
  return {
    /** The merged and failed records as they stand. */
    snapshot: () => ({ merged: state.merged, failed: state.failed, current: state.current }),
    /** The caps changed (a reload): the status file shows the ones in force. */
    setCaps(caps: SpendCaps) {
      state.caps = caps;
      save();
    },
    /** Ctrl-C was pressed: the hub shows the tab as stopping. */
    stopping() {
      stopping = true;
      save();
    },
    /** When the next queue pass starts (undefined while one runs). */
    nextPass(at: number | undefined) {
      nextPassAt = at;
      save();
    },
    /** Feed every run event through here. */
    event(e: BunkerEvent) {
      if (e.issue === undefined) return;
      if (e.type === "meta") landed.delete(e.issue);
      else if (e.type === "stage" && e.name === "waiting for merge" && landed.has(e.issue)) return;
      const i = state.current.findIndex((c) => c.issue === e.issue);
      if (e.type === "meta" && e.logPath && i >= 0) state.current[i]!.logPath = e.logPath;
      else if (e.type === "meta" && e.logPath) state.current.push({ issue: e.issue, stage: "setup", since: e.at, logPath: e.logPath });
      else if (e.type === "stage" && e.name) {
        const stage = e.name === "verify" && e.text ? `verify (${e.text})` : e.name;
        if (e.name === "merged" || e.name === "failed" || e.name === "done" || e.name === "interrupted") {
          if (i >= 0) state.current.splice(i, 1);
        } else if (i < 0) state.current.push({ issue: e.issue, stage, since: e.at });
        else if (state.current[i]!.stage !== stage) Object.assign(state.current[i]!, { stage, since: e.at });
        else return;
      } else return;
      save();
    },
    /** `at` is when it really merged, for a merge found after the fact. */
    merged(r: Omit<MergedRun, "at"> & { at?: number }) {
      state.current = state.current.filter((c) => c.issue !== r.issue);
      landed.add(r.issue);
      state.merged.push({ ...r, at: r.at ?? Date.now() });
      state.failed = state.failed.filter((f) => f.issue !== r.issue);
      save();
    },
    noChange(r: Omit<NoChangeRun, "at">) {
      state.current = state.current.filter((c) => c.issue !== r.issue);
      state.noChange.push({ ...r, at: Date.now() });
      state.failed = state.failed.filter((f) => f.issue !== r.issue);
      save();
    },
    /** Replaces the list with one pass's decisions: a PR that is no longer open drops out. */
    shepherd(runs: ShepherdRun[]) {
      state.shepherd = runs.map((r) => ({ ...r, at: Date.now() }));
      save();
    },
    failed(r: Omit<FailedRun, "at"> & { at?: number }) {
      state.current = state.current.filter((c) => c.issue !== r.issue);
      state.failed = state.failed.filter((f) => f.issue !== r.issue);
      state.failed.push({ ...r, at: r.at ?? Date.now() });
      save();
    },
  };
}

export const retryCommand = (n: number) => `gh issue edit ${n} --remove-label bunker:failed --add-label bunker:queued`;

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
    ...(raw.caps && typeof raw.caps === "object" ? { caps: { ...(typeof raw.caps.day === "number" ? { day: raw.caps.day } : {}), ...(typeof raw.caps.month === "number" ? { month: raw.caps.month } : {}) } } : {}),
    current: Array.isArray(raw.current) ? raw.current : [],
    merged: Array.isArray(raw.merged) ? raw.merged : [],
    noChange: Array.isArray(raw.noChange) ? raw.noChange : [],
    failed: Array.isArray(raw.failed) ? raw.failed : [],
    shepherd: Array.isArray(raw.shepherd) ? raw.shepherd : [],
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
  /** Open `bunker:queued` issues in priority order; null when GitHub could not be asked. */
  queue: { number: number; title: string; priority: string; bug: boolean }[] | null;
  /** Open `bunker:awaiting-review` issues (PR waits for a human), kept apart from the queue; null when GitHub could not be asked. */
  awaitingReview: { number: number; title: string }[] | null;
  /** Open `bunker-blocked` issues and what each waits on; null when GitHub could not be asked. */
  blocked: { number: number; title: string; waitingOn: number[] }[] | null;
  merged: MergedRun[];
  /** Closed without a change, with the reviewed verdict's reason. */
  noChange: NoChangeRun[];
  failed: (FailedRun & { retry?: string })[];
  /** Latest shepherd decision per open bunker PR; empty when the watcher is not alive. */
  shepherd: (ShepherdRun & { at: number })[];
  spend: { day: { spentUsd: number; capUsd?: number }; month: { spentUsd: number; capUsd?: number } };
}

export interface StatusOptions {
  /** The repo root (where `.bunker/` is). */
  repo: string;
  caps?: SpendCaps;
  /** The open `bunker:queued` issues, unordered; undefined when unavailable. */
  queue?: () => Promise<Queued[] | undefined>;
  /** The open `bunker:awaiting-review` issues; undefined when unavailable. */
  awaitingReview?: () => Promise<Queued[] | undefined>;
  /** The open `bunker-blocked` issues with their open blockers; undefined when unavailable. */
  blocked?: () => Promise<{ number: number; title: string; waitingOn: number[] }[] | undefined>;
  alive: (pid: number) => boolean;
  now?: number;
}

/** Read-only snapshot of the watcher, its runs, the queue and the spend. */
export async function collectStatus({ repo, caps: configCaps = {}, queue, awaitingReview, blocked, alive, now = Date.now() }: StatusOptions): Promise<StatusReport> {
  let caps = configCaps;
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
  // the running watcher's own caps (e.g. --max-cost-day) beat what config.toml says
  if (isAlive && mine?.caps) caps = mine.caps;
  const queued = queue ? await queue().catch(() => undefined) : undefined;
  const awaiting = awaitingReview ? await awaitingReview().catch(() => undefined) : undefined;
  const blockedIssues = blocked ? await blocked().catch(() => undefined) : undefined;
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
    awaitingReview: awaiting ? awaiting.map((q) => ({ number: q.number, title: q.title })) : null,
    blocked: blockedIssues ?? null,
    merged: mine?.merged ?? [],
    noChange: mine?.noChange ?? [],
    failed: (mine?.failed ?? [])
      .filter((f) => !(mine?.merged ?? []).some((m) => m.issue === f.issue && m.at >= f.at))
      .map((f) => ({ ...f, ...(f.status === "merge-unverified" ? {} : { retry: retryCommand(f.issue) }) })),
    shepherd: isAlive && mine ? mine.shepherd : [],
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
  if (r.awaitingReview?.length) {
    out.push("", `awaiting review: ${r.awaitingReview.length}`);
    for (const a of r.awaitingReview) out.push(`  #${a.number} ${a.title}`);
  }
  if (r.blocked?.length) {
    out.push("", `blocked: ${r.blocked.length}`);
    for (const b of r.blocked) out.push(`  #${b.number} ${b.title}${b.waitingOn.length ? ` · waiting on ${b.waitingOn.map((n) => `#${n}`).join(", ")}` : ""}`);
  }
  out.push("", `merged${w.alive ? " since the watcher started" : " in the last run"}: ${r.merged.length}`);
  for (const m of r.merged) out.push(`  #${m.issue}${m.prUrl ? ` · ${m.prUrl}` : ""}`);
  if (r.noChange.length) {
    out.push("", `closed without a change: ${r.noChange.length}`);
    for (const n of r.noChange) out.push(`  #${n.issue} no-change (${n.verdict}): ${n.reason}`);
  }
  out.push("", `failed: ${r.failed.length}`);
  for (const f of r.failed) {
    out.push(`  #${f.issue} ${f.status}: ${f.reason}`, `    ${f.prUrl ?? f.logPath ?? "no PR or log"}`, ...(f.retry ? [`    retry: ${f.retry}`] : ["    the PR merged: do not re-queue the issue, check the missing lines by hand"]));
  }
  if (r.shepherd.length) {
    out.push("", `shepherd: ${r.shepherd.length} open PR(s)`);
    for (const s of r.shepherd) out.push(`  #${s.issue} PR #${s.pr} ${s.action}${s.detail ? `: ${s.detail}` : ""}`);
  }
  const usd = (x: { spentUsd: number; capUsd?: number }) => `$${x.spentUsd.toFixed(2)}${x.capUsd === undefined ? " (no cap)" : ` of $${x.capUsd}`}`;
  out.push("", `spend: ${usd(r.spend.day)} in 24 h · ${usd(r.spend.month)} in 30 days`);
  return out.join("\n");
}

