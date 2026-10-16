import { $ } from "bun";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./redact.ts";
import { review, runSetup, type Agent, type ReviewResult, type Sandbox } from "./index.ts";

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
  /** Shell command run in the worktree, inside `sandbox`, before the first agent run. Defaults to the repo's `.bunker/setup` script if present. */
  setup?: string;
  /** Shell command run in the worktree, inside `sandbox`, once the review approves. */
  verify?: string;
  /** Run `verify` on the host (with the caller's credentials) instead of in the sandbox. */
  verifyOnHost?: boolean;
  /** After the PR opens, squash-merge it and check the merge landed. Requires `verify`. */
  merge?: boolean;
  /** With `merge`: minutes to wait for the PR's checks before giving up. Defaults to 20. */
  ciTimeoutMin?: number;
  /** Milliseconds between check polls. Defaults to 10000. */
  ciPollMs?: number;
}

export interface IssueResult {
  status: "pr-opened" | "rejected" | "failed" | "conflict" | "verify-failed" | "ci-failed" | "ci-timeout" | "merged" | "merge-failed" | "merge-unverified";
  branch: string;
  worktree: string;
  prUrl?: string;
  review?: ReviewResult;
  /** Tail of the verify command's output, when it failed. */
  verifyOutput?: string;
  error?: string;
  /** Per-run log: `<repo>/.bunker/runs/<N>-<timestamp>.log` (redacted). */
  logPath?: string;
  /** Issues filed (label `discovered`) from `<issue>` blocks the agents printed. */
  filed: { number: number; title: string }[];
}

const CONVENTIONAL_PREFIX = /^\s*(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?:\s*/i;
const MAX_SLUG = 40;
const VERIFY_TAIL = 2000;

const ISSUE_CONVENTION =
  "For problems you find outside this task's scope, do not fix them; instead print " +
  '<issue title="short title">one-paragraph body</issue> for each one.';

/** Every `<issue title="...">body</issue>` block in `text`, deduped by title (first wins). */
export function parseIssueBlocks(text: string): { title: string; body: string }[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(/<issue\s+title="([^"]*)"\s*>([\s\S]*?)<\/issue>/g)) {
    const title = m[1]!.trim();
    if (title && !seen.has(title)) seen.set(title, m[2]!.trim());
  }
  return [...seen].map(([title, body]) => ({ title, body }));
}

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

interface Rollup {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

/** "pending" if any check is unfinished, "failed" if any finished badly, "passed" otherwise (including no checks). */
function judgeChecks(rollup: Rollup[]): { outcome: "passed" | "failed" | "pending"; failed: string[] } {
  const failed: string[] = [];
  let pending = false;
  for (const c of rollup) {
    const label = c.name ?? c.context ?? "unnamed check";
    if (c.state !== undefined) {
      if (c.state === "PENDING" || c.state === "EXPECTED") pending = true;
      else if (c.state !== "SUCCESS") failed.push(`${label} (${c.state})`);
    } else if (c.status !== "COMPLETED") pending = true;
    else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? "")) failed.push(`${label} (${c.conclusion || "unknown"})`);
  }
  return { outcome: failed.length ? "failed" : pending ? "pending" : "passed", failed };
}

/** Polls the PR's status check rollup until every check finished, one failed, or the timeout passed. */
async function waitForChecks(
  prUrl: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  pollMs: number,
): Promise<{ outcome: "passed" | "failed" | "timeout"; detail?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await $`gh pr view ${prUrl} --json statusCheckRollup`.cwd(cwd).env(env).nothrow().quiet();
    // A failed or unparseable response is "pending", never "no checks".
    let rollup: Rollup[] | undefined;
    if (view.exitCode === 0) {
      try {
        rollup = JSON.parse(view.stdout.toString()).statusCheckRollup ?? [];
      } catch {}
    }
    const { outcome, failed } = rollup ? judgeChecks(rollup) : { outcome: "pending" as const, failed: [] };
    if (outcome === "passed") return { outcome };
    if (outcome === "failed") return { outcome, detail: `CI checks failed: ${failed.join(", ")}` };
    if (Date.now() >= deadline) return { outcome: "timeout", detail: `CI checks still pending after ${timeoutMs / 60_000} min` };
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Issue → worktree on its own branch → review() → optional sandboxed verify →
 * push + PR. Throws only when the issue can't be used (gh failure, closed);
 * every later outcome is a status, and the worktree and branch are always kept.
 * The caller's checkout and branch are never touched.
 */
export async function runIssue({ issue: number, cwd = process.cwd(), agent, reviewer, sandbox, maxRounds, setup, verify, verifyOnHost, merge, ciTimeoutMin = 20, ciPollMs = 10_000 }: IssueOptions): Promise<IssueResult> {
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
  const filed: IssueResult["filed"] = [];
  const logPath = join(repo, ".bunker", "runs", `${number}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  mkdirSync(join(repo, ".bunker", "runs"), { recursive: true });
  const log = (title: string, text = "") => appendFileSync(logPath, redact(`== ${title} ==\n${text.trimEnd()}\n\n`));
  log(`issue #${number}: ${issue.title}`, `branch ${branch}`);
  const fail = (status: IssueResult["status"], extra: Partial<IssueResult> = {}): IssueResult => {
    log(`final status: ${status}`, [extra.error, extra.prUrl].filter(Boolean).join("\n"));
    return finish(status, extra);
  };
  const finish = (status: IssueResult["status"], extra: Partial<IssueResult>): IssueResult => ({
    status, branch, worktree, filed, logPath, ...extra,
    ...(extra.error !== undefined ? { error: redact(extra.error) } : {}),
    ...(extra.verifyOutput !== undefined ? { verifyOutput: redact(extra.verifyOutput) } : {}),
  });

  // Keep .worktrees and run logs out of the caller's `git status` without editing a tracked file.
  const gitCommonDir = (await $`git -C ${repo} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  const exclude = join(gitCommonDir, "info", "exclude");
  const excluded = (await Bun.file(exclude).exists()) ? await Bun.file(exclude).text() : "";
  const missing = ["/.worktrees/", "/.bunker/runs/"].filter((p) => !excluded.split("\n").includes(p));
  if (missing.length) await appendFile(exclude, `${excluded && !excluded.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);

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
    "Use Conventional Commits for your commit messages, write tests first, and make the repo's tests pass.\n\n" +
    ISSUE_CONVENTION;
  const result = await review({ cwd: worktree, prompt, agent, reviewer, sandbox, maxRounds, setup, reviewerInstruction: ISSUE_CONVENTION });

  for (const [i, r] of result.rounds.entries()) {
    log(`round ${i + 1}: agent output`, r.output);
    log(`round ${i + 1}: reviewer output (${r.approved ? "approved" : "changes requested"})`, r.feedback);
  }
  if (result.error) log("review error", result.error);

  // Follow-ups the agents found: filed for human triage, never queued.
  const blocks = parseIssueBlocks(result.rounds.flatMap((r) => [r.output, r.feedback]).join("\n"));
  for (const b of blocks) {
    const body = `${b.body}\n\nFound while working on #${number}.`;
    const created = await $`gh issue create --label discovered --title ${b.title} --body ${body}`.cwd(cwd).env(env).nothrow().quiet();
    if (created.exitCode !== 0) {
      log(`gh issue create failed: ${b.title}`, created.stderr.toString());
      continue;
    }
    const n = Number(/\/issues\/(\d+)/.exec(created.stdout.toString())?.[1]);
    filed.push({ number: Number.isInteger(n) ? n : 0, title: b.title });
  }
  if (result.status !== "approved") return fail(result.status, { review: result, ...(result.error ? { error: result.error } : {}) });

  if (verify) {
    // The issue worktree is a fresh checkout too (the agent ran in review()'s own), so it needs setup as well.
    const prep = await runSetup(sandbox, { worktree, gitCommonDir }, setup);
    if (prep) {
      log(`setup (exit ${prep.code})`, prep.stdout);
      if (prep.code !== 0) return fail("failed", { review: result, error: `setup failed (exit ${prep.code}):\n${prep.stdout.slice(-VERIFY_TAIL)}` });
    }
    let code: number;
    let text: string;
    if (verifyOnHost) {
      const out = await $`sh -c ${verify}`.cwd(worktree).env(env).nothrow().quiet();
      code = out.exitCode;
      text = out.stdout.toString() + out.stderr.toString();
    } else {
      // Agent-written code: same sandbox as the agent, no GitHub tokens. stderr folded in so we can report it.
      const out = await sandbox.exec(["sh", "-c", `(${verify}) 2>&1`], { worktree, gitCommonDir });
      code = out.code;
      text = out.stdout;
    }
    log(`verify (exit ${code})`, text);
    if (code !== 0) {
      const output = text.slice(-VERIFY_TAIL);
      return fail("verify-failed", { review: result, verifyOutput: output });
    }
  }

  const push = await $`git ${gitCfg} -C ${worktree} push -q ${token ? [] : ['-u']} ${remote} ${branch}`.env(env).nothrow().quiet();
  if (push.exitCode !== 0) return fail("failed", { review: result, error: `git push failed:\n${push.stderr}` });

  const body = [`Closes #${number}`, reviewLines(result), ...(verify ? [`Verify: \`${verify}\` passed`] : [])].join("\n\n");
  const pr = await $`gh pr create --head ${branch} --title ${issue.title} --body ${body}`.cwd(worktree).env(env).nothrow().quiet();
  if (pr.exitCode !== 0) return fail("failed", { review: result, error: `gh pr create failed:\n${pr.stderr}` });
  const prUrl = pr.stdout.toString().trim().split("\n").at(-1);
  const opened = { review: result, ...(prUrl ? { prUrl } : {}) };
  if (!merge || !prUrl) return fail("pr-opened", opened);

  const ci = await waitForChecks(prUrl, worktree, env, ciTimeoutMin * 60_000, ciPollMs);
  if (ci.outcome !== "passed") {
    return fail(ci.outcome === "failed" ? "ci-failed" : "ci-timeout", { ...opened, error: ci.detail });
  }

  // No --delete-branch: gh would also switch/delete the local branch, which fails in a worktree.
  const merged = await $`gh pr merge ${prUrl} --squash`.cwd(worktree).env(env).nothrow().quiet();
  if (merged.exitCode !== 0) {
    // gh can merge on GitHub and still exit non-zero; trust the PR's actual state.
    const view = await $`gh pr view ${prUrl} --json state`.cwd(worktree).env(env).nothrow().quiet();
    let state = "unknown";
    try {
      state = JSON.parse(view.stdout.toString()).state ?? state;
    } catch {}
    if (state !== "MERGED") {
      return fail("merge-failed", { ...opened, error: `gh pr merge failed (exit ${merged.exitCode}, PR state: ${state}):\n${merged.stderr}${merged.stdout}` });
    }
  }
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

  await $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet();
  await $`git -C ${repo} branch -D ${branch}`.nothrow().quiet();
  return fail("merged", opened);
}

export interface QueueOptions extends Omit<IssueOptions, "issue"> {
  /** Max issues per run. Defaults to 5. */
  limit?: number;
}

export interface QueueEntry extends IssueResult {
  issue: number;
  title: string;
}

/**
 * Works open issues labelled `bunker`, oldest first, one at a time. Without `merge`
 * stops after the first PR opens; with `merge` continues only after `merged`.
 * Stops at the first other outcome, or after `limit` issues.
 */
export async function runQueue({ limit = 5, ...opts }: QueueOptions): Promise<QueueEntry[]> {
  const cwd = opts.cwd ?? process.cwd();
  const token = process.env.BUNKER_GH_TOKEN;
  const env = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
  const list = await $`gh issue list --label bunker --state open --json number,title,createdAt`.cwd(cwd).env(env).nothrow().quiet();
  if (list.exitCode !== 0) throw new Error(`gh issue list failed:\n${list.stderr}`);
  const queue = (JSON.parse(list.stdout.toString()) as { number: number; title: string; createdAt: string }[])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
    .slice(0, limit);
  const done: QueueEntry[] = [];
  for (const q of queue) {
    const result = await runIssue({ ...opts, cwd, issue: q.number });
    done.push({ ...result, issue: q.number, title: q.title });
    if (!opts.merge || result.status !== "merged") break;
  }
  return done;
}
