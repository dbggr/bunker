/** One thing the agent did, as reported by its streamed output. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; summary: string }
  | { type: "result"; text: string; usage?: { costUsd: number; durationMs: number } };

export type Stage = "setup" | "audit" | "implement" | "review" | "verify" | "PR" | "waiting for merge" | "merged" | "failed";

/** Progress from a run. `name` is the stage, or the tool call (e.g. "Edit src/cli.ts"). */
export interface BunkerEvent {
  type: "stage" | "text" | "toolCall" | "result" | "meta" | "note";
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
  /** On "result": what that agent run cost. */
  costUsd?: number;
  /** On "meta": the run-log path and the PR URL, once known. */
  logPath?: string;
  url?: string;
  /** Epoch milliseconds. */
  at: number;
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
  let tool = "";
  let startedAt: number | undefined;
  let where = "";
  let url = "";
  // After merged/failed the run is over: late events must not bring the live line back.
  let done = false;
  const clear = () => {
    if (live) write("\r\x1b[K");
    live = false;
  };
  const who = (e: BunkerEvent) =>
    [e.issue !== undefined ? `#${e.issue}` : e.task !== undefined ? `[${e.task}]` : "", e.round !== undefined ? `round ${e.round}` : "", e.role ?? ""]
      .filter(Boolean)
      .join(" ");
  const onEvent: OnEvent = (e) => {
    if (e.type === "meta") {
      if (e.url) url = e.url;
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
      done = e.name === "merged" || e.name === "failed";
      write(`bunker: ${[where, e.name, e.model, e.text && e.name === "failed" ? `(${e.text})` : "", e.name === "merged" && url ? `PR ${url}` : ""].filter(Boolean).join(" · ")}\n`);
      if (done) url = "";
      return;
    }
    if (done) return;
    if (e.type === "toolCall") {
      tools++;
      tool = e.name ?? "";
    }
    if (e.type === "result") {
      cost += e.costUsd ?? 0;
      tool = "";
    }
    if (!tty) return;
    where = who(e) || where;
    const line = [where, tool || "thinking", `${tools} tools`, clock(e.at - startedAt), `$${cost.toFixed(2)}`].filter(Boolean).join(" · ");
    write(`\r\x1b[K${line.length >= columns ? line.slice(0, columns - 1) : line}`);
    live = true;
  };
  return { onEvent, clear };
}
