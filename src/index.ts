import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./core/redact.ts";
import { committedCopies, copyIntoWorktree, copyPatterns, copyRejection } from "./worktree/copy.ts";
import { SEVERITY_HELP, extractOutput, reportOutput, verdictOutput, type Report, type Verdict } from "./core/structured.ts";
import { tailLines } from "./core/output.ts";
import { emit, type OnEvent, type Stage } from "./core/events.ts";
export type { BunkerEvent, OnEvent } from "./core/events.ts";
import { modelLabel } from "./agents/models.ts";
import { formatDuration, interpret, sumUsage, type Agent, type AgentMode, type Usage } from "./agents/agent.ts";
import { hardenHostGit } from "./sandboxes/git-guard.ts";
import { DEFAULT_COMPLETION_MS, IdleTimeout, agentLimits, timeoutMessage, type ExecContext, type Sandbox, type Timeouts } from "./sandboxes/exec.ts";
import { type Commit, commitsBetween, mergeBack } from "./worktree/merge.ts";
import { addWorktree, copyInto, repoInfo, runSetup, tmpWorktrees, worktreeAdmin, type Worktree } from "./worktree/admin.ts";
import { captureSession, restoreSession, sessionStore, type Session } from "./worktree/session.ts";

export { hardenHostGit } from "./sandboxes/git-guard.ts";
export type { Agent, AgentMode, Usage } from "./agents/agent.ts";
export { formatDuration, formatUsage, sumUsage } from "./agents/agent.ts";
export { CLAUDE_CREDENTIAL_VARS, claudeCode } from "./agents/claude.ts";
export type { ExecContext, ExecLimits, ExecResult, Sandbox, Timeouts } from "./sandboxes/exec.ts";
export { DEFAULT_COMPLETION_MS, DEFAULT_IDLE_MS, DEFAULT_STEP_MS, IdleTimeout, agentLimits, stepLimits, timeoutMessage } from "./sandboxes/exec.ts";
export { GH_TOKEN_VARS, isolatedEnv } from "./sandboxes/env.ts";
export { noSandbox } from "./sandboxes/no-sandbox.ts";
export type { DockerOptions } from "./sandboxes/container.ts";
export { buildBaseImage, docker, podman } from "./sandboxes/container.ts";
export type { Commit } from "./worktree/merge.ts";
export { runSetup, worktreeAdmin, worktreeAdminLockPath } from "./worktree/admin.ts";

// Every git bunker runs on the host ignores repo hooks and fsmonitor (see git-guard.ts).
hardenHostGit();

export interface RunOptions extends Timeouts {
  prompt: string;
  agent: Agent;
  sandbox: Sandbox;
  /** Repo to branch from and merge back into. Defaults to process.cwd(). */
  cwd?: string;
  /** Max times to run the agent, in the same worktree. Defaults to 1. */
  maxIterations?: number;
  /** Stop after an iteration whose stdout contains any of these. Defaults to "<promise>COMPLETE</promise>". */
  completionSignal?: string | string[];
  /** Progress events: stages, agent text and tool calls, results. */
  onEvent?: OnEvent;
  /** Continue the previous iteration's agent session instead of starting fresh. Defaults to true. */
  resume?: boolean;
  /** Host directory to keep the agent's session files in (`<role>-<round>.jsonl`). Defaults to a temporary one. */
  sessionsDir?: string;
  /** Host-relative paths or globs copied from `cwd` into the worktree (before setup), e.g. `.env`. Overrides the repo's `.bunker/copy`. Never committed. */
  copyToWorktree?: string[];
}

export interface Iteration {
  exitCode: number;
  /** The agent session this iteration ran in, if the agent reports one. */
  sessionId?: string;
  /** Commits this iteration added. */
  commits: Commit[];
  usage?: Usage;
}

export interface RunResult {
  branch: string;
  /** Total across all iterations. */
  commits: Commit[];
  iterations: Iteration[];
  /** The signal that ended the loop early, if one did. */
  completionSignal?: string;
  /** Total across all iterations, if the agent reports it. */
  usage?: Usage;
}

const DEFAULT_SIGNAL = "<promise>COMPLETE</promise>";

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
  return (line) => {
    t.onRaw?.(line);
    for (const e of agent.parseLine!(line)) {
      if (e.type === "text") emit(t.onEvent, { type: "text", ...label, text: e.text });
      else if (e.type === "toolCall") emit(t.onEvent, { type: "toolCall", ...label, name: e.summary });
      else emit(t.onEvent, { type: "result", ...label, ...(e.usage ? { costUsd: e.usage.costUsd } : {}) });
    }
  };
}

export function emitStage(t: Pick<EventTarget, "onEvent" | "task" | "round" | "role">, name: Stage, text?: string, model?: string) {
  emit(t.onEvent, { type: "stage", name, ...(model ? { model } : {}), ...(t.task !== undefined ? { task: t.task } : {}), ...(t.round !== undefined ? { round: t.round } : {}), ...(t.role ? { role: t.role } : {}), ...(text ? { text } : {}) });
}

/** Where a run stopped on the usage limit, so it can be picked up again. JSON-serialisable. */
export interface Pause {
  /** Epoch ms the limit resets, when the agent said. */
  resetAt?: number;
  role: "implementer" | "reviewer";
  /** 1-based review round. */
  round: number;
  sessionId?: string;
  /** Host copy of the session file. */
  sessionFile?: string;
  /** The review worktree and branch holding the work so far. */
  worktree: string;
  branch: string;
  /** With role `reviewer`: the implementer's output and session this round. */
  implOutput?: string;
  implSessionId?: string;
  rounds: ReviewRound[];
}

/** Thrown inside a step when the agent hit the usage limit. */
export class UsageLimit extends Error {
  constructor(readonly resetAt: number | undefined, readonly session: Session | undefined) {
    super("claude usage limit reached");
  }
}

/** A failed agent run; carries the usage already spent. */
export class AgentFailure extends Error {
  constructor(message: string, readonly usage?: Usage) {
    super(message);
  }
}

/**
 * Runs one agent command. With `prev`, first restores that session and resumes it with `resumePrompt`;
 * if that can't be done or the resumed run fails, says so and runs `prompt` in a fresh session instead.
 * The session the final run used is saved to `dest`.
 */
async function agentStep(o: {
  agent: Agent;
  sandbox: Sandbox;
  mode: AgentMode;
  prompt: string;
  resumePrompt?: string;
  prev?: Session | undefined;
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
  const exec = async (cmd: string[]) => {
    const r = await o.sandbox.exec(cmd, ctx);
    if (r.timedOut) throw new IdleTimeout(timeoutMessage(o.target.role ?? "agent", r.timedOut, timeouts));
    if (r.hung) emit(o.target.onEvent, { type: "note", ...label, text: `warning: agent did not exit ${formatDuration(timeouts.completionTimeoutMs ?? DEFAULT_COMPLETION_MS)} after finishing; killed it and treating the step as completed` });
    return r;
  };
  let res: { code: number; stdout: string } | undefined;
  if (o.prev) {
    const fallback = (why: string) =>
      emit(o.target.onEvent, { type: "note", ...(o.target.task !== undefined ? { task: o.target.task } : {}), ...(o.target.round !== undefined ? { round: o.target.round } : {}), ...(o.target.role ? { role: o.target.role } : {}), text: `could not resume session ${o.prev!.id} (${why}); starting a fresh session` });
    try {
      await restoreSession(o.sandbox, o.ctx.worktree, o.prev);
      res = await exec(o.agent.command(o.resumePrompt ?? o.prompt, o.mode, { resume: o.prev.id }));
      if (res.code !== 0 && !o.agent.usageLimit?.(res.stdout)) {
        fallback(`exit ${res.code}`);
        res = undefined;
      }
    } catch (e) {
      if (e instanceof IdleTimeout) throw e;
      fallback(redact(e instanceof Error ? e.message : String(e)));
    }
  }
  res ??= await exec(o.agent.command(o.prompt, o.mode));
  const id = o.agent.sessionId?.(res.stdout);
  const session = id ? await captureSession(o.sandbox, id, o.dest) : undefined;
  const limit = o.agent.usageLimit?.(res.stdout);
  if (limit) throw new UsageLimit(limit.resetAt, session ?? (id ? { id, file: "" } : undefined));
  return { ...res, ...(session ? { session } : {}) };
}

interface AgentOutcome {
  commits: Commit[];
  iterations: Iteration[];
  completionSignal?: string;
  usage?: Usage;
}

/**
 * Runs the agent in the worktree, again and again with the same prompt until an
 * iteration's stdout has a completion signal or maxIterations is reached.
 * The worktree is always removed; the branch never is.
 */
async function runAgent(
  cwd: string,
  base: string,
  gitCommonDir: string,
  wt: Worktree,
  { prompt, agent, sandbox, maxIterations = 1, completionSignal = DEFAULT_SIGNAL, onEvent, resume = true, sessionsDir, ...timeouts }: Omit<RunOptions, "cwd" | "copyToWorktree">,
  prefix?: string,
  task?: number,
  copied: string[] = [],
): Promise<AgentOutcome> {
  const signals = [completionSignal].flat();
  const iterations: Iteration[] = [];
  let commits: Commit[] = [];
  const store = await sessionStore(sessionsDir);
  let prev: Session | undefined;
  try {
    for (let i = 0; i < maxIterations; i++) {
      const target = { onEvent, task, round: i + 1, role: "implementer" as const };
      emitStage(target, "implement", undefined, modelLabel(agent));
      const onLine = lineHook(agent, target);
      const step = await agentStep({
        agent, sandbox, mode: "write", prompt, prev: resume ? prev : undefined, target,
        ctx: { worktree: wt.path, gitCommonDir, ...(prefix ? { prefix } : {}), ...(onLine ? { onLine } : {}) },
        dest: join(store.dir, `implementer-${i + 1}.jsonl`), timeouts, signals,
      });
      const { code, stdout } = step;
      prev = step.session;
      const { text, usage } = interpret(agent, stdout);
      if (code !== 0) {
        throw new AgentFailure(`agent exited with ${code}; work kept on ${wt.branch}`, sumUsage([...iterations.map((i) => i.usage), usage]));
      }
      const staged = await committedCopies(wt.path, base, copied);
      if (staged.length) throw new AgentFailure(`${copyRejection(staged)}; work kept on ${wt.branch}`, sumUsage([...iterations.map((i) => i.usage), usage]));
      const total = await commitsBetween(cwd, base, wt.branch);
      iterations.push({ exitCode: code, commits: total.slice(commits.length), ...(step.session ? { sessionId: step.session.id } : {}), ...(usage ? { usage } : {}) });
      commits = total;
      const matched = signals.find((s) => text.includes(s));
      if (matched) return { commits, iterations, completionSignal: matched, ...totalUsage(iterations) };
    }
    return { commits, iterations, ...totalUsage(iterations) };
  } finally {
    await store.done();
    await worktreeAdmin(cwd, () => $`git -C ${cwd} worktree remove --force ${wt.path}`.quiet());
  }
}

function totalUsage(iterations: Iteration[]): { usage?: Usage } {
  const usage = sumUsage(iterations.map((i) => i.usage));
  return usage ? { usage } : {};
}

/**
 * Branch → sandbox → collect → merge. On agent failure or merge conflict it throws,
 * keeping the branch so you can inspect what it got done.
 */
export async function run({ cwd = process.cwd(), copyToWorktree, ...opts }: RunOptions): Promise<RunResult> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const patterns = await copyPatterns(cwd, copyToWorktree);
  const wt = await addWorktree(cwd, base);
  const copied = await copyInto(cwd, wt, patterns);
  const outcome = await runAgent(cwd, base, gitCommonDir, wt, opts, undefined, undefined, copied);
  const conflict = await mergeBack(cwd, wt.branch, outcome.commits);
  if (conflict) throw new Error(conflict);
  return { branch: wt.branch, ...outcome };
}

export interface RunAllOptions extends Timeouts {
  tasks: { prompt: string }[];
  agent: Agent;
  sandbox: Sandbox;
  cwd?: string;
  /** Per task, as in run(). */
  maxIterations?: number;
  completionSignal?: string | string[];
  onEvent?: OnEvent;
  /** As in run(). */
  resume?: boolean;
  /** As in run(). */
  copyToWorktree?: string[];
}

export interface TaskResult {
  prompt: string;
  status: "merged" | "conflict" | "failed";
  branch: string;
  commits: Commit[];
  iterations: Iteration[];
  completionSignal?: string;
  usage?: Usage;
  error?: string;
}

/**
 * One worktree per task, all from the same base. Worktrees are created one at a
 * time (git takes locks on the shared .git), agents run concurrently, and merges
 * land one at a time in task order. A task's failure or conflict is reported in
 * its result, never thrown, and its branch is kept. Live output lines are
 * prefixed with the task index (`[2] `); captured stdout is not.
 */
export async function runAll({ tasks, cwd = process.cwd(), copyToWorktree, ...opts }: RunAllOptions): Promise<TaskResult[]> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const patterns = await copyPatterns(cwd, copyToWorktree);
  const worktrees: Worktree[] = [];
  const copies: string[][] = [];
  try {
    for (const _ of tasks) {
      const wt = await addWorktree(cwd, base);
      worktrees.push(wt);
      copies.push(await copyInto(cwd, wt, patterns));
    }
  } catch (e) {
    // A failing copyInto already removed its own worktree; drop the earlier, fully set up ones.
    for (const wt of worktrees.slice(0, copies.length)) {
      await worktreeAdmin(cwd, () => $`git -C ${cwd} worktree remove --force ${wt.path}`.nothrow().quiet());
      await worktreeAdmin(cwd, () => $`git -C ${cwd} branch -D ${wt.branch}`.nothrow().quiet());
    }
    throw e;
  }

  const outcomes = await Promise.allSettled(
    tasks.map((task, i) => runAgent(cwd, base, gitCommonDir, worktrees[i]!, { ...opts, prompt: task.prompt }, `[${i}] `, i, copies[i])),
  );

  const results: TaskResult[] = [];
  for (const [i, outcome] of outcomes.entries()) {
    const { prompt } = tasks[i]!;
    const { branch } = worktrees[i]!;
    if (outcome.status === "rejected") {
      const error = redact(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      const usage = outcome.reason instanceof AgentFailure ? outcome.reason.usage : undefined;
      results.push({ prompt, status: "failed", branch, commits: [], iterations: [], ...(usage ? { usage } : {}), error });
      continue;
    }
    const conflict = await mergeBack(cwd, branch, outcome.value.commits);
    results.push(
      conflict
        ? { prompt, status: "conflict", branch, ...outcome.value, error: conflict }
        : { prompt, status: "merged", branch, ...outcome.value },
    );
  }
  return results;
}

export interface ReviewOptions extends Timeouts {
  prompt: string;
  /** Implements the task (and addresses feedback). */
  agent: Agent;
  /** Reviews each round. Defaults to `agent`. */
  reviewer?: Agent;
  sandbox: Sandbox;
  cwd?: string;
  /** Max implement → review rounds. Defaults to 2. */
  maxRounds?: number;
  /** Times to re-ask the reviewer (resuming its session) for a missing or invalid `<verdict>`. Defaults to 2. */
  maxRetries?: number;
  /** Extra instruction appended to every reviewer prompt. */
  reviewerInstruction?: string;
  /** Shell command run in the worktree, inside `sandbox`, before the first agent run. Defaults to `.bunker/setup` if present. */
  setup?: string;
  /** Progress events: stages, agent text and tool calls, results. */
  onEvent?: OnEvent;
  /** Every raw stdout line of a streaming agent, redacted. */
  onRaw?: (line: string) => void;
  /** Resume the implementer's session across rounds (reviewers always start fresh). Defaults to true. */
  resume?: boolean;
  /** Host directory to keep agent session files in (`<role>-<round>.jsonl`). Defaults to a temporary one. */
  sessionsDir?: string;
  /** As in run(), copied before setup. */
  copyToWorktree?: string[];
  /** Continue a run that stopped on the usage limit (a `pause` from an earlier result): same worktree and branch, same step, same session. */
  resumeFrom?: Pause;
}

export interface ReviewRound {
  /** The implementer's agent session this round, if the agent reports one. */
  sessionId?: string;
  /** Commits the implementer added this round. */
  commits: Commit[];
  approved: boolean;
  /** The reviewer's stdout. */
  feedback: string;
  /** The reviewer's structured verdict. */
  verdict?: Verdict;
  /** The implementer's structured `<report>`, if it printed a valid one. */
  report?: Report;
  /** Why the implementer's `<report>` was ignored, when it printed one that was invalid. */
  reportError?: string;
  /** The implementer's stdout. */
  output: string;
  /** Implementer + reviewer this round. */
  usage?: Usage;
}

export interface ReviewResult {
  status: "approved" | "rejected" | "failed" | "conflict" | "bad-output" | "idle-timeout" | "paused-usage-limit";
  branch: string;
  commits: Commit[];
  rounds: ReviewRound[];
  /** With status `paused-usage-limit`: the worktree and branch are kept; pass this as `resumeFrom` to continue. */
  pause?: Pause;
  /** Implementer + reviewer, all rounds, if the agents report it. */
  usage?: Usage;
  error?: string;
}

const VERDICT_FORMAT =
  'end your answer with <verdict>{"approved": true|false, "required_changes": ["…"], "issues": [{"title": "…", "body": "…", "severity": "high|medium|low"}], "blocked_by": [{"title": "…", "body": "…"}]}</verdict>: ' +
  SEVERITY_HELP + " Valid JSON, `approved` true only if the change is acceptable, `required_changes` what must change otherwise. " +
  "Only the last <verdict> in your answer counts.";

class BadOutput extends Error {}

function reviewerPrompt(task: string, diff: string, extra?: string): string {
  return (
    `You are reviewing a change made for this task:\n\n${task}\n\n` +
    `Here is the full diff of the change:\n\n${diff}\n\n` +
    "Do not modify any files and do not commit anything. " +
    `Review it, then ${VERDICT_FORMAT}` +
    (extra ? `\n\n${extra}` : "")
  );
}

/**
 * Implement → review rounds in one worktree. The reviewer sees the task and the
 * full diff; whatever it changes or commits is discarded, so only the
 * implementer's commits survive. Approved → merged like run(). Otherwise
 * (rejected after maxRounds, failed, conflict) the result says so and the branch
 * is kept. Nothing is thrown for those outcomes.
 */
export async function review({
  cwd = process.cwd(),
  prompt,
  agent,
  reviewer = agent,
  sandbox,
  maxRounds = 2,
  maxRetries = 2,
  reviewerInstruction,
  setup,
  onEvent,
  onRaw,
  resume = true,
  sessionsDir,
  copyToWorktree,
  resumeFrom,
  ...timeouts
}: ReviewOptions): Promise<ReviewResult> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  let wt: Worktree;
  if (resumeFrom) {
    wt = { branch: resumeFrom.branch, path: resumeFrom.worktree };
    // A cleaned-up temp dir loses uncommitted work, but the branch's commits are still there.
    if (!existsSync(wt.path)) await worktreeAdmin(cwd, () => $`git -C ${cwd} worktree add -q ${wt.path} ${wt.branch}`);
  } else {
    wt = await addWorktree(cwd, base);
  }
  const ctx = { worktree: wt.path, gitCommonDir };
  const rounds: ReviewRound[] = resumeFrom ? [...resumeFrom.rounds] : [];
  let pause: Pause | undefined;
  let commits: Commit[] = [];
  const usages: (Usage | undefined)[] = [];
  let status: ReviewResult["status"] = "rejected";
  let error: string | undefined;
  const store = await sessionStore(sessionsDir);
  let prev: Session | undefined;
  let copied: string[] = [];
  /** The step in flight, for the pause record. */
  let step: { role: "implementer" | "reviewer"; round: number; implOutput?: string; implSessionId?: string } = { role: "implementer", round: 1 };
  try {
    copied = await copyIntoWorktree(cwd, wt.path, await copyPatterns(cwd, copyToWorktree));
    if (!resumeFrom) {
      emitStage({ onEvent }, "setup");
      const prep = await runSetup(sandbox, ctx, setup, timeouts);
      if (prep?.timedOut) throw new IdleTimeout(timeoutMessage("setup", prep.timedOut, timeouts));
      if (prep && prep.code !== 0) throw new Error(`setup failed (exit ${prep.code}):\n${tailLines(prep.stdout)}`);
    }
    // Resuming: the interrupted step continues its session; every earlier one is already in `rounds`.
    let resuming = resumeFrom;
    const savedSession = resumeFrom?.sessionId && resumeFrom.sessionFile ? { id: resumeFrom.sessionId, file: resumeFrom.sessionFile } : undefined;
    commits = resumeFrom ? await commitsBetween(cwd, base, wt.branch) : commits;
    for (let i = resumeFrom ? resumeFrom.round - 1 : 0; i < maxRounds; i++) {
      const feedback = rounds.at(-1)?.feedback;
      const CONTINUE = "Your session stopped on the Claude usage limit, which has now reset. Continue where you left off and finish the task.";
      const skipImpl = resuming?.role === "reviewer";
      step = { role: "implementer", round: i + 1 };
      const task = feedback === undefined ? prompt : `${prompt}\n\nA reviewer requested changes:\n${feedback}`;
      const implTarget = { onEvent, onRaw, round: i + 1, role: "implementer" as const };
      emitStage(implTarget, "implement", undefined, modelLabel(agent));
      const implHook = lineHook(agent, implTarget);
      let impl: { code: number; stdout: string; session?: Session };
      let implOut: { text: string; usage?: Usage };
      let added: Commit[] = [];
      if (skipImpl) {
        impl = { code: 0, stdout: "", ...(resumeFrom!.implSessionId ? { session: { id: resumeFrom!.implSessionId, file: join(store.dir, `implementer-${i + 1}.jsonl`) } } : {}) };
        implOut = { text: resumeFrom!.implOutput ?? "" };
      } else {
        const resumed = resuming?.role === "implementer" ? resuming : undefined;
        impl = await agentStep({
          agent, sandbox, mode: "write", prompt: task, target: implTarget,
          ...(resumed ? { resumePrompt: CONTINUE } : feedback !== undefined ? { resumePrompt: `A reviewer requested changes:\n${feedback}` } : {}),
          prev: resumed ? savedSession : resume ? prev : undefined,
          ctx: implHook ? { ...ctx, onLine: implHook } : ctx,
          dest: join(store.dir, `implementer-${i + 1}.jsonl`), timeouts,
        });
        prev = impl.session;
        implOut = interpret(agent, impl.stdout);
        usages.push(implOut.usage);
        if (impl.code !== 0) throw new Error(`agent exited with ${impl.code}; work kept on ${wt.branch}`);
        const staged = await committedCopies(wt.path, base, copied);
        if (staged.length) throw new Error(`${copyRejection(staged)}; work kept on ${wt.branch}`);
        const total = await commitsBetween(cwd, base, wt.branch);
        added = total.slice(commits.length);
        commits = total;
      }
      step = { role: "reviewer", round: i + 1, implOutput: implOut.text, ...(impl.session ? { implSessionId: impl.session.id } : {}) };

      const head = (await $`git -C ${wt.path} rev-parse HEAD`.text()).trim();
      const diff = await $`git -C ${wt.path} diff ${base}..HEAD`.text();
      const revTarget = { onEvent, onRaw, round: i + 1, role: "reviewer" as const };
      emitStage(revTarget, "review", undefined, modelLabel(reviewer));
      const revHook = lineHook(reviewer, revTarget);
      // Reviewers never resume: each review is independent.
      const revPrompt = reviewerPrompt(prompt, diff, reviewerInstruction);
      const revResumed = resuming?.role === "reviewer" ? savedSession : undefined;
      resuming = undefined;
      let rev = await agentStep({
        agent: reviewer, sandbox, mode: "review", prompt: revPrompt, target: revTarget,
        ...(revResumed ? { prev: revResumed, resumePrompt: "Your session stopped on the Claude usage limit, which has now reset. Continue the review and finish it." } : {}),
        ctx: revHook ? { ...ctx, onLine: revHook } : ctx,
        dest: join(store.dir, `reviewer-${i + 1}.jsonl`), timeouts,
      });
      let revOut = interpret(reviewer, rev.stdout);
      const attempts: (Usage | undefined)[] = [];
      let parsed = extractOutput(revOut.text, verdictOutput);
      for (let k = 1; rev.code === 0 && !parsed.ok && k <= maxRetries; k++) {
        attempts.push(revOut.usage);
        const ask = `Your answer had no usable verdict (${parsed.error}). Reply again, ${VERDICT_FORMAT}`;
        rev = await agentStep({
          agent: reviewer, sandbox, mode: "review", prompt: `${revPrompt}\n\n${ask}`, resumePrompt: ask, prev: rev.session, target: revTarget,
          ctx: revHook ? { ...ctx, onLine: revHook } : ctx,
          dest: join(store.dir, `reviewer-${i + 1}-retry${k}.jsonl`), timeouts,
        });
        revOut = interpret(reviewer, rev.stdout);
        parsed = extractOutput(revOut.text, verdictOutput);
      }
      // Only the implementer's commits survive, whatever the reviewer did.
      await $`git -C ${wt.path} reset -q --hard ${head}`.quiet();
      await $`git -C ${wt.path} clean -qfd`.quiet();
      attempts.push(revOut.usage);
      usages.push(...attempts);
      if (rev.code !== 0) throw new Error(`reviewer exited with ${rev.code}; work kept on ${wt.branch}`);
      if (!parsed.ok) throw new BadOutput(`reviewer gave bad output after ${maxRetries} retries: ${parsed.error}; work kept on ${wt.branch}`);

      const verdict = parsed.ok ? parsed.value : undefined;
      const approved = verdict?.approved === true;
      const reported = extractOutput(implOut.text, reportOutput);
      const reportError = reported.ok || !reported.present ? undefined : reported.error;
      if (reportError) emit(onEvent, { type: "note", round: i + 1, role: "implementer", text: `ignoring the implementer's <report>: ${reportError}` });
      const changes = verdict && !verdict.approved && verdict.required_changes.length ? verdict.required_changes.map((c) => `- ${c}`).join("\n") + "\n\n" : "";
      const usage = sumUsage([implOut.usage, ...attempts]);
      rounds.push({ ...(impl.session ? { sessionId: impl.session.id } : {}), commits: added, approved, feedback: changes + revOut.text, ...(verdict ? { verdict } : {}), ...(reported.ok ? { report: reported.value } : {}), ...(reportError ? { reportError } : {}), output: implOut.text, ...(usage ? { usage } : {}) });
      if (approved) {
        status = "approved";
        break;
      }
    }
  } catch (e) {
    if (e instanceof UsageLimit) {
      status = "paused-usage-limit";
      error = e.message;
      // The session was captured into the store's dest; the caller's sessionsDir keeps it.
      pause = {
        ...(e.resetAt !== undefined ? { resetAt: e.resetAt } : {}), role: step.role, round: step.round,
        ...(e.session ? { sessionId: e.session.id, ...(e.session.file ? { sessionFile: e.session.file } : {}) } : {}),
        worktree: wt.path, branch: wt.branch, rounds,
        ...(step.implOutput !== undefined ? { implOutput: step.implOutput } : {}),
        ...(step.implSessionId ? { implSessionId: step.implSessionId } : {}),
      };
    } else {
      status = e instanceof BadOutput ? "bad-output" : e instanceof IdleTimeout ? "idle-timeout" : "failed";
      error = redact(e instanceof Error ? e.message : String(e));
    }
  } finally {
    await store.done();
    // A paused run keeps its worktree: whatever the agent had not committed yet is the work.
    if (pause) tmpWorktrees.delete(wt.path); // kept for the resume
    else await worktreeAdmin(cwd, () => $`git -C ${cwd} worktree remove --force ${wt.path}`.quiet());
  }
  if (status === "approved") {
    error = await mergeBack(cwd, wt.branch, commits);
    if (error) status = "conflict";
  }
  const usage = sumUsage(usages);
  return { status, branch: wt.branch, commits, rounds, ...(usage ? { usage } : {}), ...(pause ? { pause } : {}), ...(error ? { error } : {}) };
}
