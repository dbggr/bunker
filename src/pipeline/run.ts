import { $ } from "bun";
import { join } from "node:path";
import { redact } from "../core/redact.ts";
import { committedCopies, copyPatterns, copyRejection } from "../worktree/copy.ts";
import { emitStage, lineHook, type OnEvent } from "../core/events.ts";
import { modelLabel } from "../agents/models.ts";
import { interpret, sumUsage, type Agent, type Usage } from "../agents/agent.ts";
import type { Sandbox, Timeouts } from "../sandboxes/exec.ts";
import { type Commit, commitsBetween, mergeBack } from "../worktree/merge.ts";
import { addWorktree, copyInto, repoInfo, worktreeAdmin, type Worktree } from "../worktree/admin.ts";
import { sessionStore, type Session } from "../worktree/session.ts";
import { agentStep } from "./agent-step.ts";
import { AgentFailure } from "./errors.ts";

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
