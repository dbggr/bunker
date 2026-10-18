import { $ } from "bun";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { redact } from "../../core/redact.ts";
import { emit } from "../../core/events.ts";
import { modelLabel } from "../../agents/models.ts";
import type { Agent, Usage } from "../../agents/agent.ts";
import type { Sandbox } from "../../sandboxes/exec.ts";
import { loadPromptTemplate, renderPrompt } from "../prompt.ts";
import type { Pause } from "../errors.ts";
import { review, type ReviewResult } from "../review.ts";
import type { IssueResult } from "../issue.ts";
import { ISSUE_CONVENTION, ISSUE_PROMPT, REVIEWER_CONVENTION, commentsSection, issueSection } from "../issue-prompt.ts";
import type { IssueRunContext } from "./context.ts";

export interface ImplementInput {
  agent: Agent;
  reviewer: Agent | undefined;
  sandbox: Sandbox;
  maxRounds: number | undefined;
  resume: boolean | undefined;
  setup: string | undefined;
  patterns: string[];
  paused: (Pause & { issueBaseSha: string }) | undefined;
  pausedFile: string;
  baseSha: string;
  fetchedSha: string;
  spent: { usage?: Usage };
}

/**
 * Implement + agent review: renders the issue prompt and runs review() in the worktree. `done` when the run ends here
 * (prompt failed, or paused on the usage limit); otherwise the approved-or-not review result.
 */
export async function implementIssue(ctx: IssueRunContext, input: ImplementInput): Promise<{ done: IssueResult } | { result: ReviewResult }> {
  const { number, issue, repo, branch, worktree, logPath, defaultBranch, onEvent, timeouts, log, fail, finish } = ctx;
  const { agent, reviewer, sandbox, maxRounds, resume, setup, patterns, paused, pausedFile, baseSha, spent } = input;
  // Issue text goes in as {{ISSUE}}/{{COMMENTS}} values, so it is never expanded; `!\`cmd\`` only runs from the template.
  let prompt: string;
  try {
    const originUrl = (await $`git -C ${repo} remote get-url origin`.nothrow().quiet().text()).trim();
    const repoName = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(originUrl)?.[1] ?? basename(repo);
    prompt = await renderPrompt(await loadPromptTemplate(repo, input.fetchedSha, "issue", ISSUE_PROMPT), {
      cwd: worktree,
      vars: {
        ISSUE_NUMBER: String(number), ISSUE_TITLE: issue.title, BRANCH: branch, REPO: repoName, BASE: defaultBranch,
        ISSUE: issueSection(number, issue), COMMENTS: commentsSection(issue.comments), CONVENTION: ISSUE_CONVENTION,
      },
    });
  } catch (e) {
    return { done: fail("failed", { error: e instanceof Error ? e.message : String(e) }) };
  }
  log("models", `implementer: ${modelLabel(agent)}\nreviewer: ${modelLabel(reviewer ?? agent)}`);
  log("raw agent events (stream-json lines follow, interleaved with the sections below)");
  const result = await review({ cwd: worktree, prompt, agent, reviewer, sandbox, maxRounds, ...timeouts, ...(resume !== undefined ? { resume } : {}), sessionsDir: join(repo, ".bunker", "sessions", String(number)), ...(paused ? { resumeFrom: paused } : {}), setup, copyToWorktree: patterns, reviewerInstruction: REVIEWER_CONVENTION, onEvent, onRaw: (line) => appendFileSync(logPath, redact(`${line}\n`)) });
  spent.usage = result.usage;
  if (result.status === "paused-usage-limit" && result.pause) {
    // Keep everything and remember where to pick up; the issue keeps its `bunker` label.
    mkdirSync(join(repo, ".bunker", "paused"), { recursive: true, mode: 0o700 });
    writeFileSync(pausedFile, JSON.stringify({ ...result.pause, issueBaseSha: baseSha }), { mode: 0o600 });
    const when = result.pause.resetAt !== undefined ? `resets ${new Date(result.pause.resetAt).toISOString()}` : "reset time unknown";
    const text = `#${number}: paused on the Claude usage limit (${when}); work kept on ${branch}, session ${result.pause.sessionId ?? "none"}`;
    log("paused: usage limit", text);
    emit(onEvent, { type: "note", text });
    log("final status: paused-usage-limit");
    return { done: finish("paused-usage-limit", { review: result, pause: { ...(result.pause.resetAt !== undefined ? { resetAt: result.pause.resetAt } : {}), ...(result.pause.sessionId ? { sessionId: result.pause.sessionId } : {}) } }) };
  }
  rmSync(pausedFile, { force: true });

  for (const [i, r] of result.rounds.entries()) {
    log(`round ${i + 1}: agent output`, r.output);
    log(`round ${i + 1}: reviewer output (${r.approved ? "approved" : "changes requested"})`, r.feedback);
  }
  if (result.error) log("review error", result.error);
  return { result };
}
