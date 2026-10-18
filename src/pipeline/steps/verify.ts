import { redact } from "../../core/redact.ts";
import { emit, emitStage } from "../../core/events.ts";
import { tailLines, testCounts } from "../../core/output.ts";
import { runSetup } from "../../worktree/admin.ts";
import { isolatedEnv } from "../../sandboxes/env.ts";
import type { ServiceSet, Services } from "../../sandboxes/services.ts";
import { stepLimits, timeoutMessage, type Sandbox } from "../../sandboxes/exec.ts";
import type { ReviewResult } from "../review.ts";
import type { IssueResult } from "../issue.ts";
import { VERIFY_TAIL } from "../issue-prompt.ts";
import type { IssueRunContext } from "./context.ts";

export interface VerifyInput {
  verify: string | undefined;
  verifyOnHost: boolean | undefined;
  verifyNetwork: boolean | undefined;
  /** Throwaway services (e.g. Postgres) started for each verify attempt and removed afterwards. */
  services?: Services;
  /** Command run against the services before verify (migrations, fixtures). */
  prepare?: string;
  sandbox: Sandbox;
  setup: string | undefined;
  result: ReviewResult;
  /** Fix rounds allowed after a failed verify (0: none). */
  retries?: number;
  /** Hands a verify failure to the implementer and has the reviewer re-review the fix; a failed run when that round can't finish. */
  fixRound?: (failure: string) => Promise<IssueResult | undefined>;
}

/** Setup + verify in the worktree; a failed result, or undefined when verify passed (or there is none). */
export async function runVerify(ctx: IssueRunContext, input: VerifyInput, extra: Partial<IssueResult> = {}): Promise<IssueResult | undefined> {
  if (!input.verify) return undefined;
  const retries = input.fixRound ? input.retries ?? 0 : 0;
  for (let attempt = 1; ; attempt++) {
    const failure = await verifyOnce(ctx, input, extra, attempt, retries + 1);
    if (failure.kind !== "retry") return failure.kind === "failed" ? failure.result : undefined;
    const stopped = await input.fixRound!(failure.text);
    if (stopped) return stopped;
  }
}

type Attempt = { kind: "passed" } | { kind: "failed"; result: IssueResult } | { kind: "retry"; text: string };

/** One setup + verify run; `retry` carries the failure text when a fix round is still allowed. */
async function verifyOnce(ctx: IssueRunContext, input: VerifyInput, extra: Partial<IssueResult>, attempt: number, attempts: number): Promise<Attempt> {
  const { worktree, gitCommonDir, onEvent, timeouts, log, fail, failNote } = ctx;
  const { verifyOnHost, verifyNetwork, sandbox, setup, result } = input;
  const verify = input.verify!;
  const done = (r: IssueResult): Attempt => ({ kind: "failed", result: r });
  const label = `attempt ${attempt}/${attempts}`;
  emitStage({ onEvent }, "verify", label);
  log(`verify ${label}`);
  // The issue worktree is a fresh checkout too (the agent ran in review()'s own), so it needs setup as well.
  const prep = await runSetup(sandbox, { worktree, gitCommonDir }, setup, timeouts);
  if (prep) {
    log(`setup (exit ${prep.code})`, prep.stdout);
    if (prep.timedOut) {
      const error = timeoutMessage("setup", prep.timedOut, timeouts);
      failNote(error, prep.stdout);
      return done(fail("idle-timeout", { review: result, ...extra, error }));
    }
    if (prep.code !== 0) {
      failNote(`setup failed (exit ${prep.code})`, prep.stdout);
      return done(fail("failed", { review: result, ...extra, error: `setup failed (exit ${prep.code}):\n${tailLines(prep.stdout).slice(-VERIFY_TAIL)}` }));
    }
  }
  const services = input.services && Object.keys(input.services).length ? input.services : undefined;
  if (!services && !input.prepare) return runCommands();
  if (verifyOnHost) return done(fail("failed", { review: result, ...extra, error: "services and prepare need the sandbox: they can't be combined with --verify-on-host" }));
  if (services && !sandbox.startServices) return done(fail("failed", { review: result, ...extra, error: "services need the docker or podman sandbox (not --no-sandbox)" }));
  let set: ServiceSet | undefined;
  try {
    if (services) {
      emit(onEvent, { type: "note", text: `starting services: ${Object.keys(services).join(", ")}` });
      try {
        set = await sandbox.startServices!(services);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        failNote(error, "");
        return done(fail("failed", { review: result, ...extra, error }));
      }
    }
    if (input.prepare) {
      const out = await sandbox.exec(["sh", "-c", `(${input.prepare}) 2>&1`], { worktree, gitCommonDir, limits: stepLimits(timeouts), isolate: !verifyNetwork, ...(set ? { network: set.network } : {}) });
      log(`prepare (exit ${out.code})`, out.stdout);
      if (out.timedOut) {
        const error = timeoutMessage("prepare", out.timedOut, timeouts);
        failNote(error, out.stdout);
        return done(fail("idle-timeout", { review: result, ...extra, error }));
      }
      if (out.code !== 0) {
        failNote(`prepare failed (exit ${out.code})`, out.stdout);
        return done(fail("failed", { review: result, ...extra, error: `prepare failed (exit ${out.code}):\n${tailLines(out.stdout).slice(-VERIFY_TAIL)}` }));
      }
    }
    return await runCommands(set?.network);
  } finally {
    await set?.stop();
  }

  async function runCommands(network?: string): Promise<Attempt> {
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
    const out = await sandbox.exec(["sh", "-c", `(${verify}) 2>&1`], { worktree, gitCommonDir, limits: stepLimits(timeouts), isolate: !verifyNetwork, ...(network ? { network } : {}) });
    timedOut = out.timedOut;
    code = out.code;
    text = out.stdout;
  }
  log(`verify ${label} (exit ${code})`, text);
  if (timedOut) {
    const error = timeoutMessage("verify", timedOut, timeouts);
    failNote(error, text);
    return done(fail("idle-timeout", { review: result, ...extra, error, verifyOutput: tailLines(text).slice(-VERIFY_TAIL) }));
  }
  if (code !== 0) {
    failNote(`verify failed (exit ${code})`, text);
    const verifyOutput = tailLines(text).slice(-VERIFY_TAIL);
    if (attempt < attempts) return { kind: "retry", text: redact(`verify failed (exit ${code}):\n${verifyOutput}`) };
    return done(fail("verify-failed", { review: result, ...extra, verifyOutput }));
  }
  const counts = testCounts(text);
  emit(onEvent, { type: "note", text: `verify passed (${[counts, `${((Date.now() - verifyStart) / 1000).toFixed(1)}s`].filter(Boolean).join(", ")})` });
  return { kind: "passed" };
  }
}
