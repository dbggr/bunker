import { findStreamResult, type StreamEvent } from "../core/events.ts";

export type AgentMode = "write" | "review";

/** Turns a prompt into the command line that runs the agent. */
export interface Agent {
  /** "review" is a read-only pass over someone else's work; "write" (default) is expected to commit. */
  command(prompt: string, mode?: AgentMode, opts?: { resume?: string; fork?: string }): string[];
  /** The id of the conversation the command just ran, from its raw stdout. Omit if the agent has no resumable sessions. */
  sessionId?(stdout: string): string | undefined;
  /** Whether the command stopped on the plan's usage limit, and when it resets (epoch ms) if known. Omit if the agent has no such limit. */
  usageLimit?(stdout: string): { resetAt?: number } | undefined;
  /** Turns the command's raw stdout into the agent's text plus what the run cost. Omit if stdout is already the text. */
  parse?(stdout: string): { text: string; usage?: Usage };
  /** Turns one line of the command's stdout into progress events. Omit if stdout isn't a stream. */
  parseLine?(line: string): StreamEvent[];
  /** The model this agent runs, if one is set (otherwise the agent's own default). */
  model?: string;
}

/** What a run cost. */
export interface Usage {
  costUsd: number;
  durationMs: number;
}

/** The agent's text (for signals and feedback) and usage from raw stdout. */
export function interpret(agent: Agent, stdout: string): { text: string; usage?: Usage } {
  return agent.parse ? agent.parse(stdout) : { text: stdout };
}

/** Sums usages; undefined if none was reported. */
export function sumUsage(items: (Usage | undefined)[]): Usage | undefined {
  const known = items.filter((u): u is Usage => !!u);
  if (!known.length) return undefined;
  return {
    costUsd: known.reduce((a, u) => a + u.costUsd, 0),
    durationMs: known.reduce((a, u) => a + u.durationMs, 0),
  };
}

/** "1m 5s" */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** "$0.42, 1m 5s agent time". The time is what the agent reported, not wall-clock. */
export function formatUsage(u: Usage): string {
  return `$${u.costUsd.toFixed(2)}, ${formatDuration(u.durationMs)} agent time`;
}

export const COMMIT_INSTRUCTION =
  "\n\nWhen you are done, commit your changes with git. Uncommitted work is discarded.";

// The container has no ~/.claude/settings.json, so claude would add its
// Co-Authored-By / "Generated with" lines. Pass the setting on every run so it
// holds in any image, not just the base.
export const NO_ATTRIBUTION = JSON.stringify({ attribution: { commit: "", pr: "" } });

/** Reads `claude -p --output-format stream-json` output (its final `result` event); anything else is passed through as plain text. */
export function parseClaudeJson(stdout: string): { text: string; usage?: Usage } {
  const final = findStreamResult(stdout);
  if (final) return { text: final.text, ...(final.usage ? { usage: final.usage } : {}) };
  try {
    const j = JSON.parse(stdout);
    if (typeof j?.result !== "string") return { text: stdout };
    const cost = j.total_cost_usd;
    const ms = j.duration_ms;
    return {
      text: j.result,
      ...(typeof cost === "number" ? { usage: { costUsd: cost, durationMs: typeof ms === "number" ? ms : 0 } } : {}),
    };
  } catch {
    return { text: stdout };
  }
}
