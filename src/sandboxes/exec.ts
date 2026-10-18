import { output } from "../core/output.ts";
import { redact } from "../core/redact.ts";
import { formatDuration } from "../agents/agent.ts";

/** Where the agent's command runs. Gets the worktree and the repo's shared .git dir. */
export interface Sandbox {
  /** Host directory that is the agent's `~/.claude/projects`, where its session files land. Without it nothing is resumed. */
  readonly projectsDir?: string;
  exec(cmd: string[], ctx: ExecContext): Promise<ExecResult>;
}

/** Limits on one command: kill it when it goes quiet, or when it hangs after finishing. */
export interface ExecLimits {
  /** Kill after this long without any stdout. */
  idleMs?: number;
  /** Kill after this long in total (for steps that can be legitimately quiet, like setup and verify). */
  stepMs?: number;
  /** Grace after `done` first returns true: if the process hasn't exited by then, kill it and report success. */
  graceMs?: number;
  /** Told a window of the latest stdout; true once the command has said it is finished. */
  done?: (recent: string) => boolean;
}

export interface ExecContext {
  worktree: string;
  gitCommonDir: string;
  prefix?: string;
  onLine?: (line: string) => void;
  limits?: ExecLimits;
  /** Runs agent-written code that needs neither: no network and no Claude credentials (verify). */
  isolate?: boolean;
  /** Written to the command's stdin, then closed. */
  stdin?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  /** Set when the command was killed for going quiet (`idle`) or for running too long (`step`). */
  timedOut?: "idle" | "step";
  /** Set when the command finished but hung, and was killed after the grace window; `code` is then 0. */
  hung?: boolean;
}

/** Timeouts for the agent steps and for setup/verify. */
export interface Timeouts {
  /** An agent or reviewer with no stdout for this long is killed and the step fails as `idle-timeout`. Defaults to 10 minutes. */
  idleTimeoutMs?: number;
  /** After the final stream `result` event or a closing signal, how long the process may linger before it is killed and counted as done. Defaults to 60 s. */
  completionTimeoutMs?: number;
  /** Setup and verify may be quiet: they get this overall limit instead. Defaults to 30 minutes. */
  stepTimeoutMs?: number;
}

export const DEFAULT_IDLE_MS = 10 * 60_000;
export const DEFAULT_COMPLETION_MS = 60_000;
export const DEFAULT_STEP_MS = 30 * 60_000;

/** Thrown when an agent or setup/verify step is killed for being quiet or running too long. */
export class IdleTimeout extends Error {}

/**
 * The limits for an agent step; it counts as finished once it prints a stream `result` event, or ends its output with a
 * completion signal on its own line or a closing `</verdict>`. A signal merely mentioned mid-line doesn't count, and any
 * later output cancels the grace timer.
 */
export function agentLimits(t: Timeouts, signals: string[] = []): ExecLimits {
  return {
    idleMs: t.idleTimeoutMs ?? DEFAULT_IDLE_MS,
    graceMs: t.completionTimeoutMs ?? DEFAULT_COMPLETION_MS,
    done: (recent) => {
      if (/"type"\s*:\s*"result"/.test(recent)) return true;
      const tail = recent.trimEnd();
      if (tail.endsWith("</verdict>")) return true;
      const last = tail.slice(tail.lastIndexOf("\n") + 1).trim();
      return signals.includes(last);
    },
  };
}

/** The limits for setup/verify, which can be quiet for long. */
export function stepLimits(t: Timeouts): ExecLimits {
  return { stepMs: t.stepTimeoutMs ?? DEFAULT_STEP_MS };
}

/** Why a step was killed. */
export function timeoutMessage(who: string, timedOut: "idle" | "step", t: Timeouts): string {
  return timedOut === "step"
    ? `${who} timed out after ${formatDuration(t.stepTimeoutMs ?? DEFAULT_STEP_MS)} (step timeout); killed`
    : `${who} produced no output for ${formatDuration(t.idleTimeoutMs ?? DEFAULT_IDLE_MS)} (idle timeout); killed`;
}

function prefixLines(text: string, prefix: string): string {
  return prefix ? text.replace(/^(?=.)/gm, prefix) : text;
}

/** Waits for the process, echoing its (redacted) stdout live (verbose only), each line led by `prefix`, while capturing it unprefixed. */
export async function teeStdout(proc: Bun.Subprocess<any, "pipe", "inherit">, prefix = "", onLine?: (line: string) => void, limits: ExecLimits = {}, kill: () => void = () => killGroup(proc)): Promise<ExecResult> {
  let timedOut: ExecResult["timedOut"];
  let hung = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (!limits.idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = "idle";
      kill();
    }, limits.idleMs);
  };
  const stepTimer = limits.stepMs
    ? setTimeout(() => {
        timedOut = "step";
        kill();
      }, limits.stepMs)
    : undefined;
  armIdle();
  let window = "";
  // With onLine, lines are handed over (redacted) instead of echoed.
  const out = (text: string) => {
    if (!onLine) {
      if (output.verbose) output.write(prefixLines(redact(text), prefix));
    }
    else for (const line of text.split("\n")) if (line) onLine(redact(line));
  };
  const decoder = new TextDecoder();
  let stdout = "";
  // Echo whole lines only, so a secret split across chunks is still caught.
  let pending = "";
  for await (const chunk of proc.stdout) {
    const text = decoder.decode(chunk, { stream: true });
    stdout += text;
    pending += text;
    // Real output after a "done" match means the match was a mention, not the end: back to idle watching.
    if (graceTimer && text.trim()) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
      window = "";
    }
    if (!graceTimer) {
      armIdle();
      if (limits.done) {
        window = (window + text).slice(-Math.max(4096, 2 * text.length));
        if (limits.done(window)) {
          // Finished: silence no longer matters, only whether it exits within the grace window.
          clearTimeout(idleTimer);
          graceTimer = setTimeout(() => {
            hung = true;
            kill();
          }, limits.graceMs ?? DEFAULT_COMPLETION_MS);
        }
      }
    }
    const nl = pending.lastIndexOf("\n");
    if (nl >= 0) {
      out(pending.slice(0, nl + 1));
      pending = pending.slice(nl + 1);
    }
  }
  const tail = decoder.decode();
  stdout += tail;
  pending += tail;
  // Prefixed output is interleaved with other tasks': end the last line, or the next task's runs on after it.
  if (pending) out(prefix && !onLine ? `${pending}\n` : pending);
  const exited = await proc.exited;
  clearTimeout(idleTimer);
  clearTimeout(graceTimer);
  clearTimeout(stepTimer);
  // A command killed after it said it was done counts as a success.
  const graceKilled = hung && !timedOut;
  return { code: graceKilled ? 0 : exited, stdout: redact(stdout), ...(timedOut ? { timedOut } : {}), ...(graceKilled ? { hung } : {}) };
}

/** SIGKILLs the process's whole group (agents run detached, in their own group), so children die too. */
export function killGroup(proc: Bun.Subprocess<any, any, any>) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
}
