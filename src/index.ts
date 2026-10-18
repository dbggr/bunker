import { hardenHostGit } from "./sandboxes/git-guard.ts";
export type { BunkerEvent, EventTarget, OnEvent } from "./core/events.ts";
export { emitStage, lineHook } from "./core/events.ts";

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
export type { Pause } from "./pipeline/errors.ts";
export { AgentFailure, UsageLimit } from "./pipeline/errors.ts";
export type { Iteration, RunAllOptions, RunOptions, RunResult, TaskResult } from "./pipeline/run.ts";
export { run, runAll } from "./pipeline/run.ts";
export type { ReviewOptions, ReviewResult, ReviewRound } from "./pipeline/review.ts";
export { review } from "./pipeline/review.ts";

// Every git bunker runs on the host ignores repo hooks and fsmonitor (see git-guard.ts).
hardenHostGit();
