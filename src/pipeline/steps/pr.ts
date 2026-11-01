import { $ } from "bun";
import { basename } from "node:path";
import { waitForMerge } from "../../github/branches.ts";
import { neutralise } from "../../core/redact.ts";
import { addPrLabel, AWAITING_REVIEW_LABEL, ensureLabel, REVIEW_LABEL } from "../../github/labels.ts";
import { requiredCheck } from "../../core/required-check.ts";
import { describeMissing, missingHunks } from "../landing.ts";
import { emit, emitStage } from "../../core/events.ts";
import { tailLines } from "../../core/output.ts";
import { isReviewPath } from "../../worktree/steering.ts";
import { worktreeAdmin } from "../../worktree/admin.ts";
import { stampCommits } from "../../worktree/trailer.ts";
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
  /** Manual-merge mode: the run ends at an open PR labelled `bunker:awaiting-review`; auto-merge is never requested. */
  manual: boolean | undefined;
  /** With `merge`: end the run once auto-merge is armed; a shepherd owns the PR from there. */
  handoff: boolean | undefined;
  mergeTurn: IssueOptions["mergeTurn"];
  ciTimeoutMin: number;
  ciPollMs: number;
  signal: AbortSignal | undefined;
  result: ReviewResult;
  notFiled: FollowUp[];
  remoteSha: string | undefined;
  baseSha: string;
  /** `review_paths` of the base branch's config: extra globs a human must review. */
  reviewPaths: string[];
  /** The verify step, re-run when updating to the latest default branch changed the branch. */
  runVerify: (extra?: Partial<IssueResult>) => Promise<IssueResult | undefined>;
}

/** Push, open the PR and, with `merge`, update to the latest default branch first, arm auto-merge, wait, and check the merge landed. */
export function publishIssue(ctx: IssueRunContext, input: PublishInput): Promise<IssueResult> {
  const { number, issue, repo, branch, worktree, token, env, gitCfg, remote, defaultBranch, onEvent, log, fail, fetchDefault } = ctx;
  const { agent, reviewer, verify, verifySource, merge, manual, handoff, mergeTurn, ciTimeoutMin, ciPollMs, signal, result, notFiled, remoteSha, runVerify } = input;
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

  /** The pushed ref must carry the agent's work: a branch still at the base means a commit was lost, and the worktree is kept. */
  const ensureAgentCommit = async (): Promise<IssueResult | undefined> => {
    const tip = (await $`git -C ${worktree} rev-parse --verify -q ${`refs/heads/${branch}`}`.nothrow().quiet().text()).trim();
    if (tip && tip !== input.baseSha) return undefined;
    return fail("failed", { review: result, error: `agent commit not on branch: ${branch} has no commits beyond the base; the worktree ${worktree} is kept` });
  };

  /** Marks every commit bunker made on the branch (the agent's, its update-to-latest merge) with `Bunker-Run: <log name>`, so a commit without it is a human's. */
  const stampBranch = async (): Promise<IssueResult | undefined> => {
    const ref = `refs/heads/${branch}`;
    const tip = (await $`git -C ${worktree} rev-parse ${ref}`.text()).trim();
    const stamped = await stampCommits(worktree, tip, [baseSha], basename(ctx.logPath, ".log"));
    if (stamped === tip) return undefined;
    const moved = await $`git -C ${worktree} update-ref ${ref} ${stamped} ${tip}`.nothrow().quiet();
    if (moved.exitCode !== 0) return fail("failed", { review: result, error: `could not add the Bunker-Run trailer to ${branch}:\n${moved.stderr}` });
    await $`git -C ${worktree} reset -q --soft ${stamped}`.nothrow().quiet();
    return undefined;
  };

  const publish = async (): Promise<IssueResult> => {
    if (merge && mergeTurn) {
      const failed = await updateToLatest();
      if (failed) return failed;
    }
    emitStage({ onEvent }, "PR");
    const lost = await ensureAgentCommit();
    if (lost) return lost;
    const unstamped = await stampBranch();
    if (unstamped) return unstamped;
    const push = await $`git ${gitCfg} -C ${worktree} push -q ${token ? [] : ['-u']} ${remoteSha ? [`--force-with-lease=${branch}:${remoteSha}`] : []} ${remote} ${branch}`.env(env).nothrow().quiet();
    if (push.exitCode !== 0) return fail("failed", { review: result, error: `git push failed:\n${push.stderr}` });

    const body = [`Closes #${number}`, reviewLines(result, agent, reviewer ?? agent), ...(verify ? [`Verify: \`${verify}\` passed (${verifySource})`] : []), ...(notFiled.length ? [`Follow-ups not filed (at most one high/medium per run):\n${notFiledLines(notFiled)}`] : [])].join("\n\n");
    const pr = await $`gh pr create --head ${branch} --title ${neutralise(issue.title)} --body ${body}`.cwd(worktree).env(env).nothrow().quiet();
    if (pr.exitCode !== 0) return fail("failed", { review: result, error: `gh pr create failed:\n${pr.stderr}` });
    const prUrl = pr.stdout.toString().trim().split("\n").at(-1);
    if (prUrl) emit(onEvent, { type: "meta", url: prUrl });
    const opened = { review: result, ...(prUrl ? { prUrl } : {}) };
    if (manual && prUrl) {
      await ensureLabel(AWAITING_REVIEW_LABEL, worktree, env);
      const labelled = await addPrLabel(prUrl, AWAITING_REVIEW_LABEL, worktree, env);
      return fail("awaiting-review", { ...opened, ...(labelled.ok ? {} : { error: `could not add the ${AWAITING_REVIEW_LABEL} label: ${labelled.error}` }) });
    }
    if (!merge || !prUrl) return fail("pr-opened", opened);

    // .bunker/ feeds the host (docker build, copy globs), .github/ is CI, .claude/, CLAUDE.md, AGENTS.md steer agents, and package.json, lockfiles, Makefiles and `review_paths` are what CI and verify run: only a human may merge changes to them.
    // Fails closed: if the diff can't be read, a human reviews. --no-renames lists the old path of a moved file too;
    // -z keeps paths raw (plain output quotes non-ASCII, quote and tab characters, which would dodge the match).
    const diff = await $`git -C ${worktree} diff -z --name-only --no-renames ${baseSha} HEAD`.nothrow().quiet();
    const sensitive = diff.exitCode === 0 ? diff.stdout.toString().split("\0").filter((f) => isReviewPath(f, input.reviewPaths)) : [`(could not list the changed files: ${diff.stderr.toString().trim()})`];
    if (sensitive.length) {
      await ensureLabel(REVIEW_LABEL, worktree, env);
      const labelled = await addPrLabel(prUrl, REVIEW_LABEL, worktree, env);
      const shown = sensitive.slice(0, 10).join(", ") + (sensitive.length > 10 ? ", …" : "");
      return fail("needs-review", { ...opened, error: `the PR changes ${shown}, which a human must review: bunker left auto-merge off${labelled.ok ? "" : " (could not add the bunker:review label: " + labelled.error + ")"}` });
    }

    // Without a required status check GitHub merges an already-mergeable PR the moment auto-merge is armed.
    // Checks rulesets and classic branch protection; a failed or unreadable lookup refuses too.
    const read = async (path: string) => {
      const r = await $`gh api ${path}`.cwd(worktree).env(env).nothrow().quiet();
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const gate = await requiredCheck(
      () => read(`repos/{owner}/{repo}/rules/branches/${defaultBranch}`),
      () => read(`repos/{owner}/{repo}/branches/${defaultBranch}/protection/required_status_checks`),
    );
    if (gate.rulesFailed) return fail("merge-failed", { ...opened, error: `could not read the required status checks of ${defaultBranch}, so bunker will not arm auto-merge (gh api exit ${gate.rulesFailed.code}):\n${gate.rulesFailed.err.trim()}` });
    if (gate.state === "unreadable") return fail("merge-failed", { ...opened, error: `could not read the classic branch protection of ${defaultBranch} with the run's token (it needs Administration: read on the repo), so bunker will not arm auto-merge. Grant that permission, or require the check through a ruleset instead:\n${gate.detail}` });
    if (gate.state === "none") return fail("merge-failed", { ...opened, error: `${defaultBranch} has no required status check in its rulesets or branch protection, so bunker will not arm auto-merge (the PR would merge immediately, gated only by the agent reviewer). Require a status check on ${defaultBranch} (\`bunker doctor\` checks this).` });

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
    // The shepherd (watch, or `bunker shepherd`) keeps the armed PR green and notices the merge; the slot is free now.
    if (handoff) return fail("awaiting-merge", opened);
    emitStage({ onEvent }, "waiting for merge");
    const waited = await waitForMerge(prUrl, worktree, env, ciTimeoutMin * 60_000, ciPollMs, signal);
    if (waited.outcome === "released") return fail("awaiting-merge", opened);
    if (waited.outcome !== "merged") return fail(waited.outcome === "closed" ? "merge-failed" : "ci-timeout", { ...opened, error: waited.detail });
    await $`gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/${branch}`.cwd(worktree).env(env).nothrow().quiet();

    // Squash-merges have silently dropped late commits: check that every line the PR added is on the default branch.
    const refspec = `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`;
    const refetch = await $`git ${gitCfg} -C ${repo} fetch -q ${remote} ${refspec}`.env(env).nothrow().quiet();
    if (refetch.exitCode !== 0) return fail("merge-unverified", { ...opened, error: `merged, but could not fetch to verify:\n${refetch.stderr}` });
    const target = `origin/${defaultBranch}`;
    const forkPoint = (await $`git -C ${repo} merge-base ${branch} ${target}`.nothrow().quiet().text()).trim() || baseSha;
    const missing = await missingHunks(repo, forkPoint, branch, target);
    if (!Array.isArray(missing)) return fail("merge-unverified", { ...opened, error: `merged, but could not compare ${target} with ${branch}:\n${missing.error}` });
    if (missing.length) return fail("merge-unverified", { ...opened, error: describeMissing(target, missing) });

    await worktreeAdmin(repo, () => $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet());
    await worktreeAdmin(repo, () => $`git -C ${repo} branch -D ${branch}`.nothrow().quiet());
    return fail("merged", opened);
  };
  return merge && mergeTurn ? mergeTurn(publish) : publish();
}
