import { $ } from "bun";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { review, type Agent, type ReviewResult, type Sandbox } from "./index.ts";

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
}

export interface IssueOptions {
  issue: number;
  agent: Agent;
  /** Reviews each round. Defaults to `agent`. */
  reviewer?: Agent;
  sandbox: Sandbox;
  /** The target repo's main checkout. Defaults to process.cwd(). */
  cwd?: string;
  maxRounds?: number;
  /** Shell command run on the host in the worktree once the review approves. */
  verify?: string;
  /** After the PR opens, squash-merge it and check the merge landed. Requires `verify`. */
  merge?: boolean;
}

export interface IssueResult {
  status: "pr-opened" | "rejected" | "failed" | "conflict" | "verify-failed" | "merged" | "merge-failed" | "merge-unverified";
  branch: string;
  worktree: string;
  prUrl?: string;
  review?: ReviewResult;
  /** Tail of the verify command's output, when it failed. */
  verifyOutput?: string;
  error?: string;
}

const CONVENTIONAL_PREFIX = /^\s*(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?:\s*/i;
const MAX_SLUG = 40;
const VERIFY_TAIL = 2000;

/** `fix/<N>-<slug>` for a bug-labelled issue, else `feature/<N>-<slug>`. */
export function issueBranch(issue: Pick<IssueInfo, "number" | "title" | "labels">): { branch: string; slug: string } {
  const slug = issue.title
    .replace(CONVENTIONAL_PREFIX, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, "");
  const type = issue.labels.some((l) => l.name === "bug") ? "fix" : "feature";
  return { branch: `${type}/${issue.number}-${slug}`, slug };
}

function reviewLines(result: ReviewResult): string {
  return result.rounds
    .map((r, i) => `Round ${i + 1}: ${r.commits.length} commit(s), ${r.approved ? "approved" : "changes requested"}`)
    .join("\n");
}

/**
 * Issue → worktree on its own branch → review() → optional host-side verify →
 * push + PR. Throws only when the issue can't be used (gh failure, closed);
 * every later outcome is a status, and the worktree and branch are always kept.
 * The caller's checkout and branch are never touched.
 */
export async function runIssue({ issue: number, cwd = process.cwd(), agent, reviewer, sandbox, maxRounds, verify, merge }: IssueOptions): Promise<IssueResult> {
  if (merge && !verify) throw new Error("merge requires verify");
  // With BUNKER_GH_TOKEN, gh runs as that scoped token and git talks HTTPS through gh's
  // credential helper, so neither the user's SSH key nor their gh login is used.
  const token = process.env.BUNKER_GH_TOKEN;
  const env = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
  const gitCfg = token ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
  const view = await $`gh issue view ${number} --json number,title,body,state,labels`.cwd(cwd).env(env).nothrow().quiet();
  if (view.exitCode !== 0) throw new Error(`gh issue view ${number} failed:\n${view.stderr}`);
  const issue = JSON.parse(view.stdout.toString()) as IssueInfo;
  if (issue.state.toUpperCase() !== "OPEN") throw new Error(`issue #${number} is closed`);

  const { branch, slug } = issueBranch(issue);
  const repo = (await $`git -C ${cwd} rev-parse --show-toplevel`.text()).trim();
  const worktree = join(repo, ".worktrees", `${number}-${slug}`);
  const fail = (status: IssueResult["status"], extra: Partial<IssueResult> = {}): IssueResult => ({ status, branch, worktree, ...extra });

  // Keep .worktrees out of the caller's `git status` without editing a tracked file.
  const gitCommonDir = (await $`git -C ${repo} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  const exclude = join(gitCommonDir, "info", "exclude");
  const excluded = (await Bun.file(exclude).exists()) ? await Bun.file(exclude).text() : "";
  if (!excluded.split("\n").includes("/.worktrees/")) await appendFile(exclude, `${excluded && !excluded.endsWith("\n") ? "\n" : ""}/.worktrees/\n`);

  // Branch from origin's default branch, not the caller's possibly-stale HEAD.
  let remote = "origin";
  if (token) {
    const url = (await $`git -C ${repo} remote get-url origin`.nothrow().quiet().text()).trim();
    const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url);
    if (m) remote = `https://github.com/${m[1]}.git`;
  }
  const head = await $`git ${gitCfg} -C ${repo} ls-remote --symref ${remote} HEAD`.env(env).nothrow().quiet();
  const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head.stdout.toString())?.[1] ?? "main";
  const fetch = await $`git ${gitCfg} -C ${repo} fetch -q ${remote} ${defaultBranch}`.env(env).nothrow().quiet();
  if (fetch.exitCode !== 0) return fail("failed", { error: `could not fetch origin/${defaultBranch}:\n${fetch.stderr}` });

  const baseSha = (await $`git -C ${repo} rev-parse FETCH_HEAD`.text()).trim();
  const add = await $`git -C ${repo} worktree add -q -b ${branch} ${worktree} FETCH_HEAD`.nothrow().quiet();
  if (add.exitCode !== 0) return fail("failed", { error: `could not create worktree:\n${add.stderr}` });

  const prompt =
    `Implement GitHub issue #${number}: ${issue.title}\n\n${issue.body}\n\n` +
    "Use Conventional Commits for your commit messages, write tests first, and make the repo's tests pass.";
  const result = await review({ cwd: worktree, prompt, agent, reviewer, sandbox, maxRounds });
  if (result.status !== "approved") return fail(result.status, { review: result, ...(result.error ? { error: result.error } : {}) });

  if (verify) {
    const out = await $`sh -c ${verify}`.cwd(worktree).env(env).nothrow().quiet();
    if (out.exitCode !== 0) {
      const output = (out.stdout.toString() + out.stderr.toString()).slice(-VERIFY_TAIL);
      return fail("verify-failed", { review: result, verifyOutput: output });
    }
  }

  const push = await $`git ${gitCfg} -C ${worktree} push -q ${token ? [] : ['-u']} ${remote} ${branch}`.env(env).nothrow().quiet();
  if (push.exitCode !== 0) return fail("failed", { review: result, error: `git push failed:\n${push.stderr}` });

  const body = [`Closes #${number}`, reviewLines(result), ...(verify ? [`Verify: \`${verify}\` passed`] : [])].join("\n\n");
  const pr = await $`gh pr create --title ${issue.title} --body ${body}`.cwd(worktree).env(env).nothrow().quiet();
  if (pr.exitCode !== 0) return fail("failed", { review: result, error: `gh pr create failed:\n${pr.stderr}` });
  const prUrl = pr.stdout.toString().trim().split("\n").at(-1);
  const opened = { review: result, ...(prUrl ? { prUrl } : {}) };
  if (!merge || !prUrl) return fail("pr-opened", opened);

  const merged = await $`gh pr merge ${prUrl} --squash --delete-branch`.cwd(worktree).env(env).nothrow().quiet();
  if (merged.exitCode !== 0) return fail("merge-failed", { ...opened, error: `gh pr merge failed:\n${merged.stderr}` });

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

  await $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet();
  await $`git -C ${repo} branch -D ${branch}`.nothrow().quiet();
  return fail("merged", opened);
}
