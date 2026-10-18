import { hardenHostGit } from "./sandboxes/git-guard.ts";

// The stable library API (see "Library API" in docs/concepts.md, pinned by test/public-api.test.ts).
// Everything else is internal: the CLI and tests import it from its module directly.
export type { BunkerEvent, EventTarget, OnEvent } from "./core/events.ts";
export type { Agent, AgentMode, Usage } from "./agents/agent.ts";
export { claudeCode } from "./agents/claude.ts";
export type { ExecContext, ExecLimits, ExecResult, Sandbox, Timeouts } from "./sandboxes/exec.ts";
export { noSandbox } from "./sandboxes/no-sandbox.ts";
export type { DockerOptions } from "./sandboxes/container.ts";
export { docker, podman } from "./sandboxes/container.ts";
export type { Commit } from "./worktree/merge.ts";
export type { Pause } from "./pipeline/errors.ts";
export { AgentFailure, UsageLimit } from "./pipeline/errors.ts";
export type { Iteration, RunAllOptions, RunOptions, RunResult, TaskResult } from "./pipeline/run.ts";
export { run, runAll } from "./pipeline/run.ts";
export type { ReviewOptions, ReviewResult, ReviewRound } from "./pipeline/review.ts";
export { review } from "./pipeline/review.ts";

// Every git bunker runs on the host ignores repo hooks and fsmonitor (see git-guard.ts).
hardenHostGit();
