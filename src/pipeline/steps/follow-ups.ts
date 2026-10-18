import { $ } from "bun";
import { pickFollowUps } from "../../core/structured.ts";
import { findOpenByTitle, markBlocked, openIssue } from "../../github/issues.ts";
import { neutralise } from "../../core/redact.ts";
import { emit } from "../../core/events.ts";
import { worktreeAdmin } from "../../worktree/admin.ts";
import type { ReviewResult } from "../review.ts";
import type { IssueResult } from "../issue.ts";
import { MAX_FOLLOW_UPS, collectFollowUps, notFiledLines } from "../issue-prompt.ts";
import type { IssueRunContext } from "./context.ts";

export type FollowUp = ReturnType<typeof collectFollowUps>["issues"][number];

/**
 * Files the follow-ups the agents found and, if the issue is blocked, parks it. `done` when the run ends here
 * (blocked, or the review didn't approve); otherwise the follow-ups left unfiled, for the PR body.
 */
export async function fileFollowUps(ctx: IssueRunContext, result: ReviewResult, filed: IssueResult["filed"], mention: string | undefined): Promise<{ done: IssueResult } | { notFiled: FollowUp[] }> {
  const { number, cwd, repo, branch, worktree, env, onEvent, log, fail } = ctx;
  // Follow-ups the agents found: filed for human triage, never queued.
  const { issues: blocks, blocker } = collectFollowUps(result.rounds);
  // At most one per run, high/medium only; the rest are listed in the log and the PR body.
  const { file: toFile, notFiled } = pickFollowUps(blocks, MAX_FOLLOW_UPS);
  if (notFiled.length) log("follow-ups not filed", notFiledLines(notFiled));
  for (const b of toFile) {
    const body = `${neutralise(b.body)}\n\nFound while working on #${number}.`;
    const severity = `severity:${b.severity ?? "medium"}`;
    // A repo missing the `severity:*` or `bug` label rejects the call; drop the extra labels one at a time rather than lose the follow-up.
    const attempts = [
      ["--label", severity, ...(b.bug ? ["--label", "bug"] : [])],
      ...(b.bug ? [["--label", severity]] : []),
      ...(b.bug ? [["--label", "bug"]] : []),
      [],
    ];
    let created = await $`gh issue create --label discovered ${attempts[0]!} --title ${neutralise(b.title)} --body ${body}`.cwd(cwd).env(env).nothrow().quiet();
    for (const labels of attempts.slice(1)) {
      if (created.exitCode === 0) break;
      log(`gh issue create with extra labels failed, retrying with fewer: ${b.title}`, created.stderr.toString());
      created = await $`gh issue create --label discovered ${labels} --title ${neutralise(b.title)} --body ${body}`.cwd(cwd).env(env).nothrow().quiet();
    }
    if (created.exitCode !== 0) {
      log(`gh issue create failed: ${b.title}`, created.stderr.toString());
      continue;
    }
    const n = Number(/\/issues\/(\d+)/.exec(created.stdout.toString())?.[1]);
    filed.push({ number: Number.isInteger(n) ? n : 0, title: b.title });
  }
  // The issue can't be done yet: file what it waits on, park it, and leave nothing behind.
  if (blocker) {
    // An existing open issue (named by number, or with the same title) is reused rather than filed again.
    let existing = blocker.issue && blocker.issue !== number ? await openIssue(blocker.issue, cwd, env) : undefined;
    if (blocker.issue && !existing) log(`blocked_by names #${blocker.issue}, which is not an open issue`, blocker.title);
    existing ??= await findOpenByTitle(blocker.title, cwd, env, number);
    const created = existing ? { exitCode: 0, stdout: Buffer.from(`/issues/${existing.number}`), stderr: Buffer.from("") } : await $`gh issue create --label discovered --title ${neutralise(blocker.title)} --body ${`${neutralise(blocker.body)}\n\nBlocks #${number}.`}`.cwd(cwd).env(env).nothrow().quiet();
    const m = created.exitCode === 0 ? /\/issues\/(\d+)/.exec(created.stdout.toString()) : null;
    if (!m) {
      log(`gh issue create failed: ${blocker.title}`, created.stderr.toString());
    } else {
      const blockedBy = { number: Number(m[1]), title: existing?.title ?? blocker.title };
      await markBlocked(number, blockedBy, cwd, env, mention);
      await worktreeAdmin(repo, () => $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet());
      await worktreeAdmin(repo, () => $`git -C ${repo} branch -D ${branch}`.nothrow().quiet());
      emit(onEvent, { type: "note", text: `blocked by #${blockedBy.number}: ${blockedBy.title}` });
      return { done: fail("blocked", { review: result, blockedBy }) };
    }
  }
  if (result.status !== "approved") return { done: fail(result.status, { review: result, ...(result.error ? { error: result.error } : {}) }) };
  return { notFiled };
}
