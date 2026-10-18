import { emit, emitStage } from "../../core/events.ts";
import { tailLines, testCounts } from "../../core/output.ts";
import { runSetup } from "../../worktree/admin.ts";
import { isolatedEnv } from "../../sandboxes/env.ts";
import { stepLimits, timeoutMessage, type Sandbox } from "../../sandboxes/exec.ts";
import type { ReviewResult } from "../review.ts";
import type { IssueResult } from "../issue.ts";
import { VERIFY_TAIL } from "../issue-prompt.ts";
import type { IssueRunContext } from "./context.ts";

export interface VerifyInput {
  verify: string | undefined;
  verifyOnHost: boolean | undefined;
  verifyNetwork: boolean | undefined;
  sandbox: Sandbox;
  setup: string | undefined;
  result: ReviewResult;
}

/** Setup + verify in the worktree; a failed result, or undefined when verify passed (or there is none). */
export async function runVerify(ctx: IssueRunContext, input: VerifyInput, extra: Partial<IssueResult> = {}): Promise<IssueResult | undefined> {
  const { worktree, gitCommonDir, onEvent, timeouts, log, fail, failNote } = ctx;
  const { verify, verifyOnHost, verifyNetwork, sandbox, setup, result } = input;
  if (!verify) return undefined;
  emitStage({ onEvent }, "verify");
  // The issue worktree is a fresh checkout too (the agent ran in review()'s own), so it needs setup as well.
  const prep = await runSetup(sandbox, { worktree, gitCommonDir }, setup, timeouts);
  if (prep) {
    log(`setup (exit ${prep.code})`, prep.stdout);
    if (prep.timedOut) {
      const error = timeoutMessage("setup", prep.timedOut, timeouts);
      failNote(error, prep.stdout);
      return fail("idle-timeout", { review: result, ...extra, error });
    }
    if (prep.code !== 0) {
      failNote(`setup failed (exit ${prep.code})`, prep.stdout);
      return fail("failed", { review: result, ...extra, error: `setup failed (exit ${prep.code}):\n${tailLines(prep.stdout).slice(-VERIFY_TAIL)}` });
    }
  }
  let code: number;
  let text: string;
  let timedOut: "idle" | "step" | undefined;
  const verifyStart = Date.now();
  if (verifyOnHost) {
    // Own process group (setsid) so a timeout kills the whole tree, not just the shell.
    // Agent-written code on the host: no GitHub tokens, no Claude credentials.
    const proc = Bun.spawn(["setsid", "sh", "-c", verify], { cwd: worktree, env: isolatedEnv(), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => {
      timedOut = "step";
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }, stepLimits(timeouts).stepMs);
    try {
      const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      code = proc.exitCode ?? 1;
      text = o + e;
    } finally {
      clearTimeout(timer);
    }
  } else {
    // Agent-written code: same sandbox as the agent, no GitHub tokens, and (unless opted in) no network
    // or Claude credentials. stderr folded in so we can report it.
    const out = await sandbox.exec(["sh", "-c", `(${verify}) 2>&1`], { worktree, gitCommonDir, limits: stepLimits(timeouts), isolate: !verifyNetwork });
    timedOut = out.timedOut;
    code = out.code;
    text = out.stdout;
  }
  log(`verify (exit ${code})`, text);
  if (timedOut) {
    const error = timeoutMessage("verify", timedOut, timeouts);
    failNote(error, text);
    return fail("idle-timeout", { review: result, ...extra, error, verifyOutput: tailLines(text).slice(-VERIFY_TAIL) });
  }
  if (code !== 0) {
    failNote(`verify failed (exit ${code})`, text);
    return fail("verify-failed", { review: result, ...extra, verifyOutput: tailLines(text).slice(-VERIFY_TAIL) });
  }
  const counts = testCounts(text);
  emit(onEvent, { type: "note", text: `verify passed (${[counts, `${((Date.now() - verifyStart) / 1000).toFixed(1)}s`].filter(Boolean).join(", ")})` });
  return undefined;
}
