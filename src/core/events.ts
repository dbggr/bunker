import type { Agent } from "../agents/agent.ts";
import { addTokens, estimateCostUsd, formatTokens, noTokens, type Tokens } from "./pricing.ts";
/** One thing the agent did, as reported by its streamed output. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; summary: string }
  /** Tokens of one assistant message (`id` repeats across the lines of one message). */
  | { type: "usage"; id?: string; model?: string; tokens: Tokens }
  | { type: "result"; text: string; usage?: { costUsd: number; durationMs: number } };

export type Stage = "setup" | "audit" | "filing" | "implement" | "review" | "verify" | "PR" | "waiting for merge" | "awaiting review" | "merged" | "done" | "failed" | "interrupted";

/** Progress from a run. `name` is the stage, or the tool call (e.g. "Edit src/cli.ts"). */
export interface BunkerEvent {
  type: "stage" | "text" | "toolCall" | "result" | "meta" | "note" | "usage" | "budget" | "watcher" | "filed";
  /** Set on every event of a `bunker audit` run (which has no issue number), so the hub draws it as its own card. */
  audit?: boolean;
  /** On "filed": an issue the audit filed. */
  filed?: { number: number; title: string; url?: string };
  issue?: number;
  /** Index of the task, for runAll(). */
  task?: number;
  round?: number;
  role?: "implementer" | "reviewer" | "auditor";
  /** On a "stage" that starts an agent: the model it runs ("Claude default" when none is set). */
  model?: string;
  name?: string;
  /** Agent text, the failure status on a "failed" stage, or the message of a "note" (a permanent line, may span lines). */
  text?: string;
  /** On a "failed" stage: one line saying why. */
  reason?: string;
  /** On "result": what that agent run cost. */
  costUsd?: number;
  /** On "usage": tokens so far in the running agent call, and their estimated cost (absent for a model without a price). Replaced by the exact `costUsd` of the "result". */
  tokens?: Tokens;
  estCostUsd?: number;
  /** On "budget": the watcher's spend against its caps (exact costs only). */
  budget?: Budget;
  /** On "watcher": what the running watcher knows, for the hub. */
  watcher?: WatcherInfo;
  /** On "meta": the issue title, the run-log path and the PR URL, once known. */
  title?: string;
  logPath?: string;
  url?: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface BudgetWindow {
  spentUsd: number;
  capUsd?: number;
}

export interface Budget {
  day: BudgetWindow;
  month: BudgetWindow;
  /** Set while a cap has stopped new work: when it resumes (epoch ms). */
  pausedUntil?: number;
}

/** The watcher's state as published to the hub (a subset of `.bunker/watch-status.json`, plus the schedule). */
export interface WatcherInfo {
  /** The watcher's PID (the one in `watch.lock`); the hub closes its open runs once it is gone. */
  pid?: number;
  version: string;
  startedAt: number;
  parallel: number;
  /** Set once Ctrl-C asked the watcher to stop: it finishes its in-flight steps and exits. */
  stopping?: boolean;
  /** Epoch ms of the next queue pass; absent while one is running. */
  nextPassAt?: number;
  merged: { issue: number; prUrl?: string; at: number }[];
  noChange: { issue: number; verdict: string; reason: string; at: number }[];
  failed: { issue: number; status: string; reason: string; prUrl?: string; logPath?: string; at: number }[];
  shepherd: { issue: number; pr: number; prUrl?: string; action: string; detail?: string }[];
}

export type OnEvent = (event: BunkerEvent) => void;

/** Calls `onEvent`, never letting a listener's error break the run. */
export function emit(onEvent: OnEvent | undefined, event: Omit<BunkerEvent, "at">): void {
  if (!onEvent) return;
  try {
    onEvent({ ...event, at: Date.now() });
  } catch {}
}

const TARGET_KEYS = ["file_path", "path", "command", "pattern", "url", "description", "query"] as const;

/** Parses one line of `claude --output-format stream-json`; malformed or uninteresting lines give []. */
export function parseClaudeStreamLine(line: string): StreamEvent[] {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (!j || typeof j !== "object") return [];
  if (j.type === "result" && typeof j.result === "string") {
    const cost = j.total_cost_usd;
    const ms = j.duration_ms;
    return [{
      type: "result",
      text: j.result,
      ...(typeof cost === "number" ? { usage: { costUsd: cost, durationMs: typeof ms === "number" ? ms : 0 } } : {}),
    }];
  }
  if (j.type !== "assistant" || !Array.isArray(j.message?.content)) return [];
  const out: StreamEvent[] = [];
  const u = j.message.usage;
  if (u && typeof u === "object") {
    const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    out.push({
      type: "usage",
      ...(typeof j.message.id === "string" ? { id: j.message.id } : {}),
      ...(typeof j.message.model === "string" ? { model: j.message.model } : {}),
      tokens: { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) },
    });
  }
  for (const block of j.message.content) {
    if (block?.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
    else if (block?.type === "tool_use" && typeof block.name === "string") {
      const key = TARGET_KEYS.find((k) => typeof block.input?.[k] === "string");
      const target = key ? String(block.input[key]).split("\n")[0]! : "";
      out.push({ type: "toolCall", name: block.name, summary: target ? `${block.name} ${target}` : block.name });
    }
  }
  return out;
}

/** The final `result` event in a stream-json stdout, if there is one. */
export function findStreamResult(stdout: string): Extract<StreamEvent, { type: "result" }> | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    const r = parseClaudeStreamLine(line).find((e) => e.type === "result");
    if (r?.type === "result") return r;
  }
  return undefined;
}

/** The `session_id` of the last stream-json line that carries one. */
export function findSessionId(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      const id = JSON.parse(line)?.session_id;
      if (typeof id === "string" && id) return id;
    } catch {}
  }
  return undefined;
}

/** A path as an OSC 8 terminal hyperlink to its file:// URL. */
export function hyperlink(path: string): string {
  return `\x1b]8;;file://${encodeURI(path)}\x1b\\${path}\x1b]8;;\x1b\\`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export interface ProgressOptions {
  write: (s: string) => void;
  /** Live single-line progress needs a terminal; otherwise only stage lines are printed. */
  tty: boolean;
  columns?: number;
}

/** Renders events: stage changes as permanent lines, everything else (TTY only) as one line rewritten in place. */
export function createProgress({ write, tty, columns = 100 }: ProgressOptions): { onEvent: OnEvent; clear: () => void } {
  let live = false;
  let tools = 0;
  let cost = 0;
  // Running estimate of the agent call in flight, per issue/task; replaced by the exact cost at its result.
  const running = new Map<string, { usd?: number; tokens: number }>();
  let tool = "";
  let startedAt: number | undefined;
  let where = "";
  // PR urls by issue or task, so concurrent runs never borrow each other's.
  const urls = new Map<string, string>();
  const key = (e: BunkerEvent) => (e.issue !== undefined ? `#${e.issue}` : e.task !== undefined ? `[${e.task}]` : "");
  // After merged/failed the run is over: late events must not bring the live line back.
  let done = false;
  const clear = () => {
    if (live) write("\r\x1b[K");
    live = false;
  };
  const who = (e: BunkerEvent) =>
    [key(e), e.round !== undefined ? `round ${e.round}` : "", e.role ?? ""]
      .filter(Boolean)
      .join(" ");
  const onEvent: OnEvent = (e) => {
    if (e.type === "budget") return;
    if (e.type === "meta") {
      if (e.url) urls.set(key(e), e.url);
      return;
    }
    startedAt ??= e.at;
    if (e.type === "note") {
      clear();
      where = who(e) || where;
      write(`bunker: ${[where, e.text].filter(Boolean).join(" · ")}\n`);
      return;
    }
    if (e.type === "stage") {
      clear();
      tool = "";
      tools = 0;
      where = who(e);
      done = e.name === "merged" || e.name === "done" || e.name === "failed";
      write(`bunker: ${[where, e.name, e.model, e.text && e.name === "failed" ? `(${e.text})` : "", e.name === "failed" && e.reason ? e.reason : "", e.name === "merged" && urls.get(key(e)) ? `PR ${urls.get(key(e))}` : ""].filter(Boolean).join(" · ")}\n`);
      if (done) urls.delete(key(e));
      return;
    }
    if (done) return;
    if (e.type === "toolCall") {
      tools++;
      tool = e.name ?? "";
    }
    if (e.type === "usage") running.set(key(e), { ...(e.estCostUsd === undefined ? {} : { usd: e.estCostUsd }), tokens: e.tokens ? e.tokens.input + e.tokens.output + e.tokens.cacheRead + e.tokens.cacheWrite : 0 });
    if (e.type === "result") {
      cost += e.costUsd ?? 0;
      running.delete(key(e));
      tool = "";
    }
    if (!tty) return;
    const money = () => {
      const est = [...running.values()];
      const usd = est.reduce((a, r) => a + (r.usd ?? 0), 0);
      const unpriced = est.reduce((a, r) => a + (r.usd === undefined ? r.tokens : 0), 0);
      return [est.some((r) => r.usd !== undefined) ? `~$${(cost + usd).toFixed(2)}` : `$${cost.toFixed(2)}`, unpriced ? `${formatTokens(unpriced)} tok` : ""].filter(Boolean).join(" · ");
    };
    where = who(e) || where;
    const line = [where, tool || "thinking", `${tools} tools`, clock(e.at - startedAt), money()].filter(Boolean).join(" · ");
    write(`\r\x1b[K${line.length >= columns ? line.slice(0, columns - 1) : line}`);
    live = true;
  };
  return { onEvent, clear };
}

/**
 * Whether a stream-json stdout ends in claude hitting the plan's usage limit, and when it resets (epoch ms) if it says.
 * Matches an error `result` whose subtype or message names the limit; ordinary results that merely mention one, and transient rate-limit errors, don't count.
 */
export function findUsageLimit(stdout: string): { resetAt?: number } | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j?.type !== "result") continue;
    const text = typeof j.result === "string" ? j.result : "";
    const kind = typeof j.subtype === "string" ? j.subtype : "";
    const named = /usage[_ ]limit|(?<!rate[_ ])limit reached/i; // a bare "rate limit" (API 429) is transient, not the plan limit
    if (!(j.is_error === true && (named.test(text) || named.test(kind))) && !/usage_limit/i.test(kind)) return undefined;
    const field = j.resets_at ?? j.reset_at ?? j.resetsAt;
    let at: number | undefined;
    if (typeof field === "number") at = field < 1e11 ? field * 1000 : field;
    else if (typeof field === "string" && !Number.isNaN(Date.parse(field))) at = Date.parse(field);
    else {
      const epoch = /\|\s*(\d{9,13})\b/.exec(text)?.[1];
      const iso = /\b(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))/.exec(text)?.[1];
      if (epoch) at = epoch.length <= 10 ? Number(epoch) * 1000 : Number(epoch);
      else if (iso && !Number.isNaN(Date.parse(iso))) at = Date.parse(iso);
    }
    return at !== undefined ? { resetAt: at } : {};
  }
  return undefined;
}

/** Where an agent run's events are labelled from, and where raw stdout lines go. */
export interface EventTarget {
  onEvent?: OnEvent | undefined;
  /** Every raw stdout line of a streaming agent (already redacted). */
  onRaw?: ((line: string) => void) | undefined;
  task?: number;
  round?: number;
  role?: "implementer" | "reviewer" | "auditor";
}

/** The exec `onLine` hook for `agent`: parsed events to onEvent, raw lines to onRaw. Undefined if nobody listens or the agent doesn't stream. */
export function lineHook(agent: Agent, t: EventTarget): ((line: string) => void) | undefined {
  if (!agent.parseLine || (!t.onEvent && !t.onRaw)) return undefined;
  const label = { ...(t.task !== undefined ? { task: t.task } : {}), ...(t.round !== undefined ? { round: t.round } : {}), ...(t.role ? { role: t.role } : {}) };
  // Per call: the latest tokens of each message, so a message split over several lines counts once.
  const seen = new Map<string, { model?: string; tokens: Tokens }>();
  let anon = 0;
  return (line) => {
    t.onRaw?.(line);
    for (const e of agent.parseLine!(line)) {
      if (e.type === "usage") {
        seen.set(e.id ?? `anon${anon++}`, { ...(e.model ? { model: e.model } : {}), tokens: e.tokens });
        let tokens = noTokens();
        let usd: number | undefined;
        for (const m of seen.values()) {
          tokens = addTokens(tokens, m.tokens);
          const c = estimateCostUsd(m.model, m.tokens);
          if (c !== undefined) usd = (usd ?? 0) + c;
        }
        // A message of an unknown model has tokens but no price: the dollar figure would understate, so drop it.
        const priced = [...seen.values()].every((m) => estimateCostUsd(m.model, m.tokens) !== undefined);
        emit(t.onEvent, { type: "usage", ...label, tokens, ...(priced && usd !== undefined ? { estCostUsd: usd } : {}) });
      } else if (e.type === "text") emit(t.onEvent, { type: "text", ...label, text: e.text });
      else if (e.type === "toolCall") emit(t.onEvent, { type: "toolCall", ...label, name: e.summary });
      else emit(t.onEvent, { type: "result", ...label, ...(e.usage ? { costUsd: e.usage.costUsd } : {}) });
    }
  };
}

export function emitStage(t: Pick<EventTarget, "onEvent" | "task" | "round" | "role">, name: Stage, text?: string, model?: string) {
  emit(t.onEvent, { type: "stage", name, ...(model ? { model } : {}), ...(t.task !== undefined ? { task: t.task } : {}), ...(t.round !== undefined ? { round: t.round } : {}), ...(t.role ? { role: t.role } : {}), ...(text ? { text } : {}) });
}
