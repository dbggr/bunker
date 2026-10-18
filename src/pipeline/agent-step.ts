import { redact } from "../core/redact.ts";
import { emit, type EventTarget } from "../core/events.ts";
import { formatDuration, stdinOf, type Agent, type AgentMode } from "../agents/agent.ts";
import { DEFAULT_COMPLETION_MS, IdleTimeout, agentLimits, timeoutMessage, type ExecContext, type Sandbox, type Timeouts } from "../sandboxes/exec.ts";
import { captureSession, restoreSession, type Session } from "../worktree/session.ts";
import { UsageLimit } from "./errors.ts";

/**
 * Runs one agent command. With `prev`, first restores that session and resumes it with `resumePrompt`;
 * if that can't be done or the resumed run fails, says so and runs `prompt` in a fresh session instead.
 * The session the final run used is saved to `dest`.
 */
export async function agentStep(o: {
  agent: Agent;
  sandbox: Sandbox;
  mode: AgentMode;
  prompt: string;
  resumePrompt?: string;
  prev?: Session | undefined;
  /** Continue from this session in a new one, leaving it unchanged. No fresh-session fallback: a fork that cannot start fails. */
  fork?: Session | undefined;
  ctx: ExecContext;
  target: Pick<EventTarget, "onEvent" | "task" | "round" | "role">;
  dest: string;
  timeouts?: Timeouts;
  /** Completion signals; one alone on the last output line marks the agent as finished. */
  signals?: string[];
}): Promise<{ code: number; stdout: string; session?: Session }> {
  const timeouts = o.timeouts ?? {};
  const label = { ...(o.target.task !== undefined ? { task: o.target.task } : {}), ...(o.target.round !== undefined ? { round: o.target.round } : {}), ...(o.target.role ? { role: o.target.role } : {}) };
  const ctx: ExecContext = { ...o.ctx, limits: agentLimits(timeouts, o.signals) };
  /** Runs the command; a killed one throws IdleTimeout, a hung-but-finished one is noted and counts as done. */
  const exec = async (cmd: string[], prompt: string) => {
    const r = await o.sandbox.exec(cmd, { ...ctx, ...stdinOf(o.agent, prompt, o.mode) });
    if (r.timedOut) throw new IdleTimeout(timeoutMessage(o.target.role ?? "agent", r.timedOut, timeouts));
    if (r.hung) emit(o.target.onEvent, { type: "note", ...label, text: `warning: agent did not exit ${formatDuration(timeouts.completionTimeoutMs ?? DEFAULT_COMPLETION_MS)} after finishing; killed it and treating the step as completed` });
    return r;
  };
  let res: { code: number; stdout: string } | undefined;
  if (o.fork) {
    await restoreSession(o.sandbox, o.ctx.worktree, o.fork);
    res = await exec(o.agent.command(o.prompt, o.mode, { fork: o.fork.id }), o.prompt);
  }
  if (o.prev && !res) {
    const fallback = (why: string) =>
      emit(o.target.onEvent, { type: "note", ...(o.target.task !== undefined ? { task: o.target.task } : {}), ...(o.target.round !== undefined ? { round: o.target.round } : {}), ...(o.target.role ? { role: o.target.role } : {}), text: `could not resume session ${o.prev!.id} (${why}); starting a fresh session` });
    try {
      await restoreSession(o.sandbox, o.ctx.worktree, o.prev);
      res = await exec(o.agent.command(o.resumePrompt ?? o.prompt, o.mode, { resume: o.prev.id }), o.resumePrompt ?? o.prompt);
      if (res.code !== 0 && !o.agent.usageLimit?.(res.stdout)) {
        fallback(`exit ${res.code}`);
        res = undefined;
      }
    } catch (e) {
      if (e instanceof IdleTimeout) throw e;
      fallback(redact(e instanceof Error ? e.message : String(e)));
    }
  }
  res ??= await exec(o.agent.command(o.prompt, o.mode), o.prompt);
  const id = o.agent.sessionId?.(res.stdout);
  const session = id ? await captureSession(o.sandbox, id, o.dest) : undefined;
  const limit = o.agent.usageLimit?.(res.stdout);
  if (limit) throw new UsageLimit(limit.resetAt, session ?? (id ? { id, file: "" } : undefined));
  return { ...res, ...(session ? { session } : {}) };
}
