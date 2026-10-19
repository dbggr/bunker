import { liveGhEnv } from "../github/identity.ts";
import type { OnEvent } from "../core/events.ts";
import { AgentFailure } from "./errors.ts";
import type { NoChange } from "../core/structured.ts";
import type { ReviewResult } from "./review.ts";
import type { Timeouts, Sandbox } from "../sandboxes/exec.ts";
import type { Agent, Usage } from "../agents/agent.ts";
import { runIssueInner } from "./issue-run.ts";
import { clearInProgress, markInProgress } from "../github/labels.ts";

export interface IssueOptions extends Timeouts {
  issue: number;
  agent: Agent;
  /** Reviews each round. Defaults to `agent`. */
  reviewer?: Agent;
  sandbox: Sandbox;
  /** The target repo's main checkout. Defaults to process.cwd(). */
  cwd?: string;
  /** `@login` put in the comment when the issue becomes `bunker-blocked`, so GitHub notifies the user. */
  mention?: string;
  /** Logins besides admin/maintain whose edits after the queue label are trusted (`--allow-labeler`). */
  allowLabelers?: string[];
  maxRounds?: number;
  /** Resume the implementer's agent session across review rounds. Defaults to true. */
  resume?: boolean;
  /** Shell command run in the worktree, inside `sandbox`, before the first agent run. Defaults to `setup` in .bunker/config.toml. */
  setup?: string;
  /** Host-relative paths or globs copied from the repo checkout into the worktree before setup (e.g. `.env`). Overrides `.bunker/copy`. Never committed. */
  copyToWorktree?: string[];
  /** Shell command run in the worktree, inside `sandbox`, once the review approves. */
  verify?: string;
  /** Fix rounds the implementer gets when verify fails. Defaults to `verify_retries` in the base branch's .bunker/config.toml, else 1. */
  verifyRetries?: number;
  /** Shell command run in the sandbox before each review; its output goes into the reviewer prompt. Defaults to `check` in the base branch's .bunker/config.toml. */
  check?: string;
  /** Run `verify` on the host (with the caller's credentials) instead of in the sandbox. */
  verifyOnHost?: boolean;
  /** Let sandboxed verify use the network (and Claude credentials). Off by default: verify runs agent-written code. */
  verifyNetwork?: boolean;
  /** After the PR opens, squash-merge it and check the merge landed. Requires `verify`. */
  merge?: boolean;
  /** Manual-merge mode: end at an open PR labelled `bunker:awaiting-review`, without requesting auto-merge. Excludes `merge`. */
  manual?: boolean;
  /** With `merge`: end the run once auto-merge is armed instead of waiting for the merge (a shepherd takes over the PR). */
  handoff?: boolean;
  /** With `merge`: minutes to wait for GitHub to auto-merge the PR before giving up. Defaults to 30. */
  ciTimeoutMin?: number;
  /** Milliseconds between PR state polls. Defaults to 10000. */
  ciPollMs?: number;
  /** Progress events (stages, agent text and tool calls, results), each labelled with the issue. */
  onEvent?: OnEvent;
  /**
   * With `merge`: runs the publish-and-merge step (update to the latest default branch, re-verify, push, PR, auto-merge, wait)
   * when it is this issue's turn, so parallel issues merge one at a time. Without it the branch is pushed as it is.
   */
  mergeTurn?: (run: () => Promise<IssueResult>) => Promise<IssueResult>;
  /** 1 for the first attempt; later ones get a `-<n>` suffix on the branch and worktree. */
  attempt?: number;
  /** The queue order this issue was picked in (`queue: #160 (high, bug) · #131`); written to its run log. */
  queueOrder?: string;
}

export interface IssueResult {
  status: "pr-opened" | "rejected" | "failed" | "conflict" | "verify-failed" | "ci-timeout" | "merged" | "merge-failed" | "merge-unverified" | "blocked" | "bad-output" | "idle-timeout" | "already-in-progress" | "paused-usage-limit" | "needs-review" | "awaiting-merge" | "awaiting-review" | "no-change";
  /** With status `paused-usage-limit`: where the run stopped. Re-running the issue (or the next watch pass) resumes it. */
  pause?: { resetAt?: number; sessionId?: string };
  /** With status `no-change`: the verdict the reviewer agreed with, and for which bunker closed the issue. */
  noChange?: NoChange;
  /** With status `blocked`: the `discovered` issue filed for what this one waits on. */
  blockedBy?: { number: number; title: string };
  branch: string;
  worktree: string;
  prUrl?: string;
  review?: ReviewResult;
  /** Spend when the run threw instead of producing a `review` (otherwise see `review.usage`). */
  usage?: Usage;
  /** The failure came after the branch was brought up to date with the default branch (a conflict, or verify failing on the result). */
  stale?: boolean;
  /** Tail of the verify command's output, when it failed. */
  verifyOutput?: string;
  error?: string;
  /** Per-run log: `<repo>/.bunker/runs/<N>-<timestamp>.log` (redacted). */
  logPath?: string;
  /** Issues filed (label `discovered`) from `<issue>` blocks the agents printed. */
  filed: { number: number; title: string }[];
}

/**
 * Issue → worktree on its own branch → review() → optional sandboxed verify →
 * push + PR. Throws only when the issue can't be used (gh failure, closed);
 * every later outcome is a status, and the worktree and branch are always kept.
 * The caller's checkout and branch are never touched.
 */
export async function runIssue(opts: IssueOptions): Promise<IssueResult> {
  const spent: { usage?: Usage } = {};
  let untrack = () => {};
  // The label only displays the run: it is shown on start and cleared on any end, and nothing reads it back.
  const cwd = opts.cwd ?? process.cwd();
  const env = liveGhEnv();
  await markInProgress(opts.issue, cwd, env);
  let other = false; // another run holds this issue and owns its label
  try {
    const result = await runIssueInner(opts, spent, (u) => (untrack = u));
    other = result.status === "already-in-progress";
    return result;
  } catch (e) {
    // Whatever the agents already spent must not vanish with the error.
    if (spent.usage && !(e instanceof AgentFailure)) throw new AgentFailure(e instanceof Error ? e.message : String(e), spent.usage);
    throw e;
  } finally {
    untrack();
    if (!other) await clearInProgress(opts.issue, cwd, env);
  }
}
