import { $ } from "bun";
import { emit, emitStage } from "../../core/events.ts";
import { oneLine } from "../../core/reason.ts";
import { QUEUED_LABEL, issueLabels, unqueue } from "../../github/labels.ts";
import { worktreeAdmin } from "../../worktree/admin.ts";
import type { ReviewResult } from "../review.ts";
import type { IssueResult } from "../issue.ts";
import { closeReason, noChangeComment, repoWebUrl } from "../no-change.ts";
import type { IssueRunContext } from "./context.ts";

/**
 * The reviewer agreed the issue needs no change: bunker (not the agent) comments with the verdict, reason and evidence, closes the issue
 * with the matching reason, and drops `bunker:queued`. Only an issue still carrying `bunker:queued` (the normal label gate) is closed.
 * The worktree and its empty branch are removed.
 */
export async function closeNoChange(ctx: IssueRunContext, result: ReviewResult, baseSha: string): Promise<IssueResult> {
  const { number, cwd, repo, branch, worktree, env, defaultBranch, onEvent, log, fail, finish } = ctx;
  const v = result.noChange!;
  const labels = await issueLabels(number, cwd, env);
  if (!labels?.includes(QUEUED_LABEL)) return fail("failed", { review: result, error: `not closing #${number} without a change: it no longer carries ${QUEUED_LABEL} (or its labels could not be read)` });
  const body = noChangeComment(v, { web: await repoWebUrl(repo, cwd, env), baseSha, defaultBranch });
  let close = await $`gh issue close ${number} --comment ${body} --reason ${closeReason(v)} ${v.verdict === "duplicate" ? ["--duplicate-of", String(v.duplicate_of)] : []}`.cwd(cwd).env(env).nothrow().quiet();
  if (close.exitCode !== 0 && v.verdict === "duplicate") {
    // An older gh has no --duplicate-of; the comment still names the duplicate.
    log("gh issue close --duplicate-of failed, closing as not planned", close.stderr.toString());
    close = await $`gh issue close ${number} --comment ${body} --reason ${"not planned"}`.cwd(cwd).env(env).nothrow().quiet();
  }
  if (close.exitCode !== 0) return fail("failed", { review: result, error: `gh issue close failed: ${close.stderr.toString().trim()}` });
  const edit = await unqueue(number, cwd, env, ["--remove-label", "bunker:in-progress"]);
  if (edit.exitCode !== 0) log("could not remove labels", edit.stderr.toString());
  await worktreeAdmin(repo, () => $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet());
  await worktreeAdmin(repo, () => $`git -C ${repo} branch -D ${branch}`.nothrow().quiet());
  log("final status: no-change", `${v.verdict}: ${v.reason}\n${v.evidence.join("\n")}`);
  emit(onEvent, { type: "note", text: `#${number}: no change needed (${v.verdict}): ${oneLine(v.reason)}` });
  emitStage({ onEvent }, "done");
  return finish("no-change", { review: result, noChange: v });
}
