import type { RepoConfig } from "../core/config.ts";
import type { resolveTimeouts } from "../core/settings.ts";
import type { Agent } from "../agents/agent.ts";
import { formatUsage } from "../agents/agent.ts";
import type { Sandbox } from "../sandboxes/exec.ts";
import { runIssue } from "../pipeline/issue.ts";
import { runQueue } from "../pipeline/queue.ts";
import { enforceLabeler } from "../github/labeler.ts";
import { hyperlink, type BunkerEvent } from "../core/events.ts";
import type { Publisher } from "../ui/ui.ts";
import type { CliValues } from "./args.ts";

/** When to re-run after a usage-limit pause (exit code 3). */
export function rerunHint(resetAt?: number): string {
  return resetAt !== undefined ? `re-run after ${new Date(resetAt).toISOString()} to resume` : "re-run later to resume (no reset time was given)";
}

/** What the bunker queue and bunker issue handlers take from main.ts. */
export interface PipelineContext {
  /** Manual-merge mode: runs end at an open PR labelled `bunker:awaiting-review`. */
  manual: boolean;
  values: CliValues;
  repoCfg: RepoConfig;
  onEvent: (e: BunkerEvent) => void;
  agent: Agent;
  reviewerAgent: () => Agent;
  sandbox: Sandbox;
  maxRounds: number;
  resume: boolean;
  limit: number;
  ciTimeoutMin: number | undefined;
  timeouts: ReturnType<typeof resolveTimeouts>;
  parallel: number;
  allowLabelers: string[];
  publisher: Publisher | undefined;
  tty: boolean;
}

export async function queueCommand({ manual, values, repoCfg, onEvent, agent, reviewerAgent, sandbox, maxRounds, resume, limit, ciTimeoutMin, timeouts, parallel, allowLabelers, publisher, tty }: PipelineContext) {
  const reviewer = reviewerAgent();
  let results;
  try {
    results = await runQueue({ onEvent, agent, reviewer, sandbox, maxRounds, resume, limit, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], verifyNetwork: repoCfg.verify_network === true, merge: values.merge, manual, ciTimeoutMin, ...timeouts, parallel, allowLabelers });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    await publisher?.flush();
    process.exit(2);
  }
  console.log();
  if (!results.length) console.log("bunker: queue is empty");
  for (const r of results) {
    console.log(`#${r.issue} [${r.status}] ${r.prUrl ?? "-"}`);
    if (r.error) console.log(`  ${r.error.trimEnd().replaceAll("\n", "\n  ")}`);
    if (r.logPath) console.log(`  log: ${tty ? hyperlink(r.logPath) : r.logPath}`);
    if (r.review?.usage) console.log(`  cost ${formatUsage(r.review.usage)}`);
    for (const f of r.filed) console.log(`  filed #${f.number}: ${f.title}`);
  }
  const pausedRun = results.find((r) => r.status === "paused-usage-limit");
  if (pausedRun) {
    console.log(`bunker: paused on the Claude usage limit (#${pausedRun.issue}); ${rerunHint(pausedRun.pause?.resetAt)}`);
    process.exitCode = 3;
  } else if (results.some((r) => r.status !== "blocked" && r.status !== "already-in-progress" && r.status !== "needs-review" && r.status !== (values.merge ? "merged" : manual ? "awaiting-review" : "pr-opened"))) process.exitCode = 1;
}

export async function issueCommand({ manual, values, repoCfg, onEvent, agent, reviewerAgent, sandbox, maxRounds, resume, ciTimeoutMin, timeouts, allowLabelers, publisher, tty }: PipelineContext) {
  const issue = Number(values.issue);
  if (!Number.isInteger(issue) || issue < 1) {
    console.error("bunker: issue number must be a positive integer");
    await publisher?.flush();
    process.exit(2);
  }
  const reviewer = reviewerAgent();
  let result;
  try {
    const token = process.env.BUNKER_GH_TOKEN;
    const ghEnv = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
    if (!(await enforceLabeler(issue, { cwd: process.cwd(), env: ghEnv, allow: allowLabelers }))) {
      await publisher?.flush();
      process.exit(1);
    }
    result = await runIssue({ onEvent, issue, agent, reviewer, sandbox, maxRounds, resume, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], verifyNetwork: repoCfg.verify_network === true, merge: values.merge, manual, ciTimeoutMin, ...timeouts });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    await publisher?.flush();
    process.exit(2);
  }
  console.log();
  for (const [i, r] of (result.review?.rounds ?? []).entries()) {
    console.log(`bunker: round ${i + 1}: ${r.commits.length} commit(s), ${r.approved ? "approved" : "changes requested"}`);
  }
  console.log(`bunker: [${result.status}] ${result.branch} (worktree ${result.worktree})`);
  if (result.status === "paused-usage-limit") console.log(`bunker: paused on the Claude usage limit; ${rerunHint(result.pause?.resetAt)}`);
  if (result.error) console.log(`  ${result.error.trimEnd().replaceAll("\n", "\n  ")}`);
  if (result.prUrl) console.log(result.prUrl);
  if (result.review?.usage) console.log(`bunker: cost ${formatUsage(result.review.usage)}`);
  if (result.logPath) console.log(`bunker: log ${tty ? hyperlink(result.logPath) : result.logPath}`);
  if (result.status === "paused-usage-limit") process.exitCode = 3;
  else if (result.status !== (values.merge ? "merged" : manual ? "awaiting-review" : "pr-opened") && result.status !== "needs-review") process.exitCode = 1;
}
