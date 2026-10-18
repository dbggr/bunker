import { $ } from "bun";
import { waitForMerge } from "../../github/branches.ts";
import { neutralise } from "../../core/redact.ts";
import { emit, emitStage } from "../../core/events.ts";
import { tailLines } from "../../core/output.ts";
import { worktreeAdmin } from "../../worktree/admin.ts";
import type { Agent } from "../../agents/agent.ts";
import type { ReviewResult } from "../review.ts";
import type { IssueOptions, IssueResult } from "../issue.ts";
import { notFiledLines, reviewLines } from "../issue-prompt.ts";
import type { FollowUp } from "./follow-ups.ts";
import type { IssueRunContext } from "./context.ts";

export interface PublishInput {
  agent: Agent;
  reviewer: Agent | undefined;
  verify: string | undefined;
  verifySource: string;
  merge: boolean | undefined;
  mergeTurn: IssueOptions["mergeTurn"];
  ciTimeoutMin: number;
  ciPollMs: number;
  result: ReviewResult;
  notFiled: FollowUp[];
  remoteSha: string | undefined;
  baseSha: string;
  /** The verify step, re-run when updating to the latest default branch changed the branch. */
  runVerify: (extra?: Partial<IssueResult>) => Promise<IssueResult | undefined>;
}

/** Push, open the PR and, with `merge`, update to the latest default branch first, arm auto-merge, wait, and check the merge landed. */
export function publishIssue(ctx: IssueRunContext, input: PublishInput): Promise<IssueResult> {
  const { number, issue, repo, branch, worktree, token, env, gitCfg, remote, defaultBranch, onEvent, log, fail, fetchDefault } = ctx;
  const { agent, reviewer, verify, verifySource, merge, mergeTurn, ciTimeoutMin, ciPollMs, result, notFiled, remoteSha, runVerify } = input;
  let baseSha = input.baseSha;

  /** Merges the latest default branch into the branch; re-verifies if that changed anything. Undefined when all is well. */
  const updateToLatest = async (): Promise<IssueResult | undefined> => {
    emit(onEvent, { type: "note", text: `updating to origin/${defaultBranch}` });
    const refetched = await fetchDefault();
    if ("error" in refetched) return fail("failed", { review: result, error: `could not fetch origin/${defaultBranch}:\n${refetched.error}` });
    const latest = refetched.sha;
    const before = (await $`git -C ${worktree} rev-parse HEAD`.text()).trim();
    const identity = (await $`git -C ${worktree} config user.email`.nothrow().quiet().text()).trim() ? [] : ["-c", "user.name=bunker", "-c", "user.email=bunker@localhost"];
    const merged = await $`git ${identity} -C ${worktree} merge --no-edit ${latest}`.env(env).nothrow().quiet();
    if (merged.exitCode !== 0) {
      const out = `${merged.stdout}${merged.stderr}`;
      await $`git -C ${worktree} merge --abort`.nothrow().quiet();
      log("update to latest: conflict", out);
      return fail("conflict", { review: result, stale: true, error: `could not merge origin/${defaultBranch} into ${branch}:\n${tailLines(out)}` });
    }
    baseSha = latest;
    if ((await $`git -C ${worktree} rev-parse HEAD`.text()).trim() === before) return undefined;
    log("update to latest", `merged origin/${defaultBranch} (${latest})`);
    return runVerify({ stale: true });
  };

  const publish = async (): Promise<IssueResult> => {
    if (merge && mergeTurn) {
      const failed = await updateToLatest();
      if (failed) return failed;
    }
    emitStage({ onEvent }, "PR");
    const push = await $`git ${gitCfg} -C ${worktree} push -q ${token ? [] : ['-u']} ${remoteSha ? [`--force-with-lease=${branch}:${remoteSha}`] : []} ${remote} ${branch}`.env(env).nothrow().quiet();
    if (push.exitCode !== 0) return fail("failed", { review: result, error: `git push failed:\n${push.stderr}` });

    const body = [`Closes #${number}`, reviewLines(result, agent, reviewer ?? agent), ...(verify ? [`Verify: \`${verify}\` passed (${verifySource})`] : []), ...(notFiled.length ? [`Follow-ups not filed (at most one high/medium per run):\n${notFiledLines(notFiled)}`] : [])].join("\n\n");
    const pr = await $`gh pr create --head ${branch} --title ${neutralise(issue.title)} --body ${body}`.cwd(worktree).env(env).nothrow().quiet();
    if (pr.exitCode !== 0) return fail("failed", { review: result, error: `gh pr create failed:\n${pr.stderr}` });
    const prUrl = pr.stdout.toString().trim().split("\n").at(-1);
    if (prUrl) emit(onEvent, { type: "meta", url: prUrl });
    const opened = { review: result, ...(prUrl ? { prUrl } : {}) };
    if (!merge || !prUrl) return fail("pr-opened", opened);

    // .bunker/ feeds the host (docker build, copy globs) and .github/ is CI: only a human may merge changes to them.
    // Fails closed: if the diff can't be read, a human reviews. --no-renames lists the old path of a moved file too;
    // -z keeps paths raw (plain output quotes non-ASCII, quote and tab characters, which would dodge the match).
    const diff = await $`git -C ${worktree} diff -z --name-only --no-renames ${baseSha} HEAD`.nothrow().quiet();
    const sensitive = diff.exitCode === 0 ? diff.stdout.toString().split("\0").filter((f) => /^\.(bunker|github)\//.test(f)) : [`(could not list the changed files: ${diff.stderr.toString().trim()})`];
    if (sensitive.length) {
      await $`gh label create needs-human-review --color D93F0B --description "bunker will not auto-merge this PR" --force`.cwd(worktree).env(env).nothrow().quiet();
      const labelled = await $`gh pr edit ${prUrl} --add-label needs-human-review`.cwd(worktree).env(env).nothrow().quiet();
      const shown = sensitive.slice(0, 10).join(", ") + (sensitive.length > 10 ? ", …" : "");
      return fail("needs-review", { ...opened, error: `the PR changes ${shown}, which a human must review: bunker left auto-merge off${labelled.exitCode === 0 ? "" : " (could not add the needs-human-review label: " + labelled.stderr.toString().trim() + ")"}` });
    }

    // Without a required status check GitHub merges an already-mergeable PR the moment auto-merge is armed.
    // Reads the repository ruleset endpoint only; a failed or unreadable lookup refuses too.
    const rules = await $`gh api repos/{owner}/{repo}/rules/branches/${defaultBranch}`.cwd(worktree).env(env).nothrow().quiet();
    if (rules.exitCode !== 0) return fail("merge-failed", { ...opened, error: `could not read the required status checks of ${defaultBranch}, so bunker will not arm auto-merge (gh api exit ${rules.exitCode}):\n${rules.stderr.toString().trim()}` });
    let hasRequiredCheck = false;
    try {
      const list = JSON.parse(rules.stdout.toString()) as { type?: string; parameters?: { required_status_checks?: unknown[] } }[];
      hasRequiredCheck = list.some((r) => r.type === "required_status_checks" && (r.parameters?.required_status_checks?.length ?? 0) > 0);
    } catch {}
    if (!hasRequiredCheck) return fail("merge-failed", { ...opened, error: `${defaultBranch} has no required status check in its rulesets, so bunker will not arm auto-merge (the PR would merge immediately, gated only by the agent reviewer). Require a status check on ${defaultBranch} (\`bunker doctor\` checks this).` });

    // GitHub merges once the required checks pass (and refuses if they fail), so bunker never reads CI.
    // No --delete-branch: gh would also switch/delete the local branch, which fails in a worktree.
    const armed = await $`gh pr merge ${prUrl} --auto --squash`.cwd(worktree).env(env).nothrow().quiet();
    if (armed.exitCode !== 0) {
      const out = `${armed.stderr}${armed.stdout}`;
      if (!/auto[- ]?merge/i.test(out)) return fail("merge-failed", { ...opened, error: `gh pr merge --auto failed (exit ${armed.exitCode}):\n${out}` });
      // Never merge immediately: without auto-merge + required checks the only gate before the default branch is the agent reviewer.
      return fail("merge-failed", {
        ...opened,
        error: `the repo doesn't allow auto-merge, so bunker will not merge the PR (it would merge before CI finishes). Enable "Allow auto-merge" and require a status check on the default branch (\`bunker doctor\` checks both).\n${out}`,
      });
    }
    emitStage({ onEvent }, "waiting for merge");
    const waited = await waitForMerge(prUrl, worktree, env, ciTimeoutMin * 60_000, ciPollMs);
    if (waited.outcome !== "merged") return fail(waited.outcome === "closed" ? "merge-failed" : "ci-timeout", { ...opened, error: waited.detail });
    await $`gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/${branch}`.cwd(worktree).env(env).nothrow().quiet();

    // Squash-merges have silently dropped late commits: check every file the branch touched.
    const refspec = `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`;
    const refetch = await $`git ${gitCfg} -C ${repo} fetch -q ${remote} ${refspec}`.env(env).nothrow().quiet();
    if (refetch.exitCode !== 0) return fail("merge-unverified", { ...opened, error: `merged, but could not fetch to verify:\n${refetch.stderr}` });
    const target = `origin/${defaultBranch}`;
    const files = (await $`git -C ${repo} diff --name-only ${baseSha} ${branch}`.text()).split("\n").filter(Boolean);
    const differing = files.length
      ? (await $`git -C ${repo} diff --name-only ${branch} ${target} -- ${files}`.text()).split("\n").filter(Boolean)
      : [];
    if (differing.length) {
      return fail("merge-unverified", { ...opened, error: `merged, but ${target} differs from ${branch} in:\n${differing.join("\n")}` });
    }

    await worktreeAdmin(repo, () => $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet());
    await worktreeAdmin(repo, () => $`git -C ${repo} branch -D ${branch}`.nothrow().quiet());
    return fail("merged", opened);
  };
  return merge && mergeTurn ? mergeTurn(publish) : publish();
}
