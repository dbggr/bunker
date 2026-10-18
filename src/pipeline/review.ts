import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../core/redact.ts";
import { committedCopies, copyIntoWorktree, copyPatterns, copyRejection } from "../worktree/copy.ts";
import { SEVERITY_HELP, extractOutput, reportOutput, verdictOutput, type Report, type Verdict } from "../core/structured.ts";
import { tailLines } from "../core/output.ts";
import { emit, emitStage, lineHook, type OnEvent } from "../core/events.ts";
import { modelLabel } from "../agents/models.ts";
import { interpret, sumUsage, type Agent, type Usage } from "../agents/agent.ts";
import { IdleTimeout, stepLimits, timeoutMessage, type Sandbox, type Timeouts } from "../sandboxes/exec.ts";
import { type Commit, commitsBetween, mergeBack } from "../worktree/merge.ts";
import { addWorktree, repoInfo, runSetup, tmpWorktrees, worktreeAdmin, type Worktree } from "../worktree/admin.ts";
import { sessionStore, type Session } from "../worktree/session.ts";
import { restoreSteering } from "../worktree/steering.ts";
import { agentStep } from "./agent-step.ts";
import { UsageLimit, type Pause } from "./errors.ts";

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
  /** Shell command run in the worktree, inside `sandbox` (isolated), after each implementer round; its output goes into the reviewer prompt. */
  check?: string;
  /** A fix round: the implementer's first run gets `prompt` after the task, resuming `session` if given, and the reviewer is told what was being fixed. */
  fix?: { prompt: string; session?: Session };
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
  /** The implementer's last session, to continue in a fix round. */
  implSession?: Session;
  error?: string;
}

export const VERDICT_FORMAT =
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
  check,
  fix,
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
  let undoSteering = async () => {};
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
      const fixing = i === 0 && !resumeFrom ? fix : undefined;
      const task = fixing ? `${prompt}\n\n${fixing.prompt}` : feedback === undefined ? prompt : `${prompt}\n\nA reviewer requested changes:\n${feedback}`;
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
          ...(resumed ? { resumePrompt: CONTINUE } : fixing ? { resumePrompt: fixing.prompt } : feedback !== undefined ? { resumePrompt: `A reviewer requested changes:\n${feedback}` } : {}),
          prev: resumed ? savedSession : resume ? prev ?? fixing?.session : undefined,
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

      let checkText = "";
      if (check) {
        const out = await sandbox.exec(["sh", "-c", `(${check}) 2>&1`], { ...ctx, limits: stepLimits(timeouts), isolate: true });
        if (out.timedOut) throw new IdleTimeout(timeoutMessage("check", out.timedOut, timeouts));
        checkText = `Output of the repo's check command (\`${check}\`, exit ${out.code}):\n${redact(tailLines(out.stdout, 60).slice(-4000))}`;
      }
      const head = (await $`git -C ${wt.path} rev-parse HEAD`.text()).trim();
      const diff = await $`git -C ${wt.path} diff ${base}..HEAD`.text();
      const revTarget = { onEvent, onRaw, round: i + 1, role: "reviewer" as const };
      emitStage(revTarget, "review", undefined, modelLabel(reviewer));
      const revHook = lineHook(reviewer, revTarget);
      // The reviewer reads the default branch's .claude/, CLAUDE.md and AGENTS.md, never the agent's (reset away below).
      undoSteering = await restoreSteering(wt.path, base);
      // Reviewers never resume: each review is independent.
      const fixNote = fixing ? `This is a fix round: the diff above covers only the fix, made after verify failed. The implementer was told:\n${fixing.prompt}` : undefined;
      const revPrompt = reviewerPrompt(prompt, diff, [reviewerInstruction, fixNote, checkText].filter(Boolean).join("\n\n") || undefined);
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
      await undoSteering();
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
    await undoSteering().catch(() => {}); // a paused run keeps its worktree
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
  return { status, branch: wt.branch, commits, rounds, ...(usage ? { usage } : {}), ...(prev ? { implSession: prev } : {}), ...(pause ? { pause } : {}), ...(error ? { error } : {}) };
}
