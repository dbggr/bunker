import { liveGhEnv } from "../github/identity.ts";
import { issueBranch, type IssueInfo } from "../github/issues.ts";
import { markTrust } from "../github/trust.ts";
import { claimRemoteBranch } from "../github/branches.ts";
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../core/redact.ts";
import { parseConfig, REMOVED_FILES, removedFileMessage } from "../core/config.ts";
import { copyIntoWorktree, copyPatterns } from "../worktree/copy.ts";
import { emit, emitStage, hyperlink, type OnEvent } from "../core/events.ts";
import { tailLines } from "../core/output.ts";
import { sumUsage } from "../agents/agent.ts";
import { review } from "./review.ts";
import { failureReason } from "../core/reason.ts";
import type { Pause } from "./errors.ts";
import { worktreeAdmin } from "../worktree/admin.ts";
import type { Usage } from "../agents/agent.ts";
import type { IssueOptions, IssueResult } from "./issue.ts";
import { reclaimLeftover, track } from "./issue-cleanup.ts";
import { REVIEWER_CONVENTION } from "./issue-prompt.ts";
import type { IssueRunContext } from "./steps/context.ts";
import { implementIssue } from "./steps/implement.ts";
import { fileFollowUps } from "./steps/follow-ups.ts";
import { runVerify } from "./steps/verify.ts";
import { publishIssue } from "./steps/pr.ts";
import { closeNoChange } from "./steps/close.ts";

export async function runIssueInner({ issue: number, cwd = process.cwd(), agent, reviewer, sandbox, maxRounds, resume, setup, copyToWorktree, verify, verifyRetries, check, verifyOnHost, verifyNetwork, merge, manual, handoff, ciTimeoutMin = 30, ciPollMs = 10_000, onEvent: rawOnEvent, mergeTurn, attempt = 1, queueOrder, mention, ...timeouts }: IssueOptions, spent: { usage?: Usage }, setUntrack: (u: () => void) => void): Promise<IssueResult> {
  const onEvent: OnEvent | undefined = rawOnEvent && ((e) => rawOnEvent({ ...e, issue: number }));
  // With BUNKER_GH_TOKEN, gh runs as that scoped token and git talks HTTPS through gh's
  // credential helper, so neither the user's SSH key nor their gh login is used.
  const token = process.env.BUNKER_GH_TOKEN;
  const env = liveGhEnv();
  const gitCfg = token ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
  const view = await $`gh issue view ${number} --json number,title,body,author,state,labels,comments`.cwd(cwd).env(env).nothrow().quiet();
  if (view.exitCode !== 0) throw new Error(`gh issue view ${number} failed:\n${view.stderr}`);
  const issue = JSON.parse(view.stdout.toString()) as IssueInfo;
  // `gh issue view` doesn't expose the issue's author association, so ask the REST API; fail closed to untrusted.
  const assoc = await $`gh api repos/{owner}/{repo}/issues/${number} --jq .author_association`.cwd(cwd).env(env).nothrow().quiet();
  issue.authorAssociation = assoc.exitCode === 0 ? assoc.stdout.toString().trim() : "";
  await markTrust(issue, cwd, env);
  if (issue.state.toUpperCase() !== "OPEN") throw new Error(`issue #${number} is closed`);

  const base = issueBranch(issue);
  const slug = attempt > 1 ? `${base.slug}-${attempt}` : base.slug;
  const branch = attempt > 1 ? `${base.branch}-${attempt}` : base.branch;
  const repo = (await $`git -C ${cwd} rev-parse --show-toplevel`.text()).trim();
  const worktree = join(repo, ".worktrees", `${number}-${slug}`);
  const filed: IssueResult["filed"] = [];
  const logPath = join(repo, ".bunker", "runs", `${number}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  mkdirSync(join(repo, ".bunker", "runs"), { recursive: true, mode: 0o700 });
  writeFileSync(logPath, "", { mode: 0o600, flag: "a" });
  const log = (title: string, text = "") => appendFileSync(logPath, redact(`== ${title} ==\n${text.trimEnd()}\n\n`));
  log(`issue #${number}: ${issue.title}`, `branch ${branch}`);
  if (queueOrder) log("queue order", queueOrder);
  emit(onEvent, { type: "meta", logPath });
  const fail = (status: IssueResult["status"], extra: Partial<IssueResult> = {}): IssueResult => {
    log(`final status: ${status}`, [extra.error, extra.prUrl].filter(Boolean).join("\n"));
    if (status === "merged") emitStage({ onEvent }, "merged");
    else if (!["pr-opened", "needs-review", "awaiting-merge", "awaiting-review", "no-change"].includes(status)) {
      const reason = failureReason(status, logPath, { ...(extra.error ? { error: extra.error } : {}), ...(extra.verifyOutput ? { verifyOutput: extra.verifyOutput } : {}) });
      emit(onEvent, { type: "stage", name: "failed", text: status, reason });
    }
    return finish(status, extra);
  };
  // The terminal gets the tail of a failed step's output and where the full log is; the rest lives in the log.
  const failNote = (title: string, text: string) => {
    const where = process.stdout.isTTY ? hyperlink(logPath) : logPath;
    emit(onEvent, { type: "note", text: `${title}\n${redact(tailLines(text))}\nlog: ${where}` });
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
  const missing = ["/.worktrees/", "/.bunker/runs/", "/.bunker/sessions/", "/.bunker/paused/"].filter((p) => !excluded.split("\n").includes(p));
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
  /**
   * Origin's default branch commit, or the fetch's stderr. Not via FETCH_HEAD: parallel issues (and other bunker
   * processes) share the repo, and their fetches rewrite it between ours and our read. A private ref is ours alone.
   */
  const fetchDefault = async (): Promise<{ sha: string } | { error: string }> => {
    const ref = `refs/bunker/fetch/${number}-${crypto.randomUUID()}`;
    const fetched = await $`git ${gitCfg} -C ${repo} fetch -q --no-write-fetch-head ${remote} ${`+refs/heads/${defaultBranch}:${ref}`}`.env(env).nothrow().quiet();
    if (fetched.exitCode !== 0) return { error: fetched.stderr.toString() };
    const sha = (await $`git -C ${repo} rev-parse ${ref}`.text()).trim();
    await $`git -C ${repo} update-ref -d ${ref}`.nothrow().quiet();
    return { sha };
  };
  const fetched = await fetchDefault();
  if ("error" in fetched) return fail("failed", { error: `could not fetch origin/${defaultBranch}:\n${fetched.error}` });

  let baseSha = fetched.sha;
  let remoteSha: string | undefined;
  // Default verify: `verify` in the base branch's .bunker/config.toml, read now so the agent can't weaken it in its worktree.
  let verifySource = "--verify";
  // Read from the base branch, so the agent can't weaken them in its worktree.
  const show = async (path: string) => {
    const f = await $`git -C ${repo} show ${`${baseSha}:${path}`}`.nothrow().quiet();
    return f.exitCode === 0 ? f.stdout.toString() : undefined;
  };
  for (const name of REMOVED_FILES) if ((await show(`.bunker/${name}`)) !== undefined) return fail("failed", { error: removedFileMessage(name) });
  let fromToml: string | undefined;
  try {
    const toml = await show(".bunker/config.toml");
    const cfg = toml === undefined ? undefined : parseConfig(toml).config;
    fromToml = cfg?.verify;
    verifyRetries ??= cfg?.verify_retries;
    check ??= cfg?.check?.trim() || undefined;
  } catch (e) {
    return fail("failed", { error: e instanceof Error ? e.message : String(e) });
  }
  if (!verify) {
    if (fromToml?.trim()) {
      verify = fromToml.trim();
      verifySource = ".bunker/config.toml";
    }
  }
  if (merge && manual) return fail("failed", { error: "merge and manual-merge mode exclude each other" });
  if (merge && !verify) return fail("failed", { error: "merge requires --verify, verify in .bunker/config.toml" });
  if (verifyOnHost && !verify) return fail("failed", { error: "--verify-on-host requires --verify, verify in .bunker/config.toml" });
  let patterns: string[];
  try {
    patterns = await copyPatterns(repo, copyToWorktree);
  } catch (e) {
    return fail("failed", { error: e instanceof Error ? e.message : String(e) });
  }
  // An earlier run that stopped on the usage limit is continued, not reclaimed.
  const pausedFile = join(repo, ".bunker", "paused", `${number}.json`);
  let paused: (Pause & { issueBaseSha: string }) | undefined;
  if (attempt === 1 && existsSync(pausedFile)) {
    try {
      const saved = JSON.parse(readFileSync(pausedFile, "utf8")) as Pause & { issueBaseSha: string };
      const hasBranch = (await $`git -C ${repo} rev-parse --verify -q ${`refs/heads/${branch}`}`.nothrow().quiet()).exitCode === 0;
      if (existsSync(worktree) && hasBranch && typeof saved.issueBaseSha === "string") paused = saved;
    } catch {}
    if (!paused) rmSync(pausedFile, { force: true });
  }
  if (paused) {
    baseSha = paused.issueBaseSha;
    const remoteState = await claimRemoteBranch({ repo, cwd, number, branch, worktree, baseSha, remote, gitCfg, env, log, onEvent });
    if (remoteState.prUrl) return fail("already-in-progress", { prUrl: remoteState.prUrl });
    remoteSha = remoteState.remoteSha;
    setUntrack(track({ repo, worktree, branch, base: baseSha }));
    log("resuming after the usage limit", `session ${paused.sessionId ?? "(none)"}, ${paused.role} round ${paused.round}`);
    emit(onEvent, { type: "note", text: `#${number}: resuming after the usage limit (session ${paused.sessionId ?? "none"})` });
  } else {
  // A restart can leave this issue's branch (and worktree) behind; reclaim it, or defer to its open PR.
  const leftover = await reclaimLeftover({ repo, cwd, number, branch, worktree, baseSha, remote, gitCfg, env, log, onEvent });
  remoteSha = leftover.remoteSha;
  if (leftover.prUrl) return fail("already-in-progress", { prUrl: leftover.prUrl });
  const add = await worktreeAdmin(repo, () => $`git -C ${repo} worktree add -q -b ${branch} ${worktree} ${baseSha}`.nothrow().quiet());
  if (add.exitCode !== 0) return fail("failed", { error: `could not create worktree:\n${add.stderr}` });
  setUntrack(track({ repo, worktree, branch, base: baseSha }));
  try {
    await copyIntoWorktree(repo, worktree, patterns);
  } catch (e) {
    return fail("failed", { error: redact(`could not copy files into the worktree: ${e instanceof Error ? e.message : e}`) });
  }
  }

  const ctx: IssueRunContext = { number, cwd, issue, repo, branch, worktree, logPath, token, env, gitCfg, remote, defaultBranch, gitCommonDir, onEvent, timeouts, log, fail, finish, failNote, fetchDefault };
  const implemented = await implementIssue(ctx, { agent, reviewer, sandbox, maxRounds, resume, setup, patterns, paused, pausedFile, baseSha, fetchedSha: fetched.sha, spent, check });
  if ("done" in implemented) return implemented.done;
  const { result } = implemented;

  const followUps = await fileFollowUps(ctx, result, filed, mention);
  if ("done" in followUps) return followUps.done;
  const { notFiled } = followUps;
  if (result.noChange) return closeNoChange(ctx, result, baseSha);

  /** A verify failure goes back to the implementer (same session) as one more round, which the reviewer re-reviews. */
  const fixRound = async (failure: string): Promise<IssueResult | undefined> => {
    const fix = await review({
      cwd: worktree, prompt: implemented.prompt, agent, reviewer, sandbox, maxRounds, ...timeouts, ...(resume !== undefined ? { resume } : {}),
      sessionsDir: join(repo, ".bunker", "sessions", String(number), `verify-${result.rounds.length}`),
      setup, ...(check ? { check } : {}), copyToWorktree: patterns, reviewerInstruction: REVIEWER_CONVENTION, onEvent,
      onRaw: (line) => appendFileSync(logPath, redact(`${line}\n`)),
      fix: { prompt: `Your change was approved, but the repo's verify command failed on it. Fix the problem so verify passes, and commit.\n\n${failure}`, ...(result.implSession ? { session: result.implSession } : {}) },
    });
    for (const [i, r] of fix.rounds.entries()) {
      log(`verify fix round ${i + 1}: agent output`, r.output);
      log(`verify fix round ${i + 1}: reviewer output (${r.approved ? "approved" : "changes requested"})`, r.feedback);
    }
    if (fix.error) log("verify fix round error", fix.error);
    const usage = sumUsage([result.usage, fix.usage]);
    Object.assign(result, { rounds: [...result.rounds, ...fix.rounds], commits: [...result.commits, ...fix.commits], ...(usage ? { usage } : {}), ...(fix.implSession ? { implSession: fix.implSession } : {}) });
    spent.usage = result.usage;
    if (fix.status === "approved") return undefined;
    const error = fix.status === "paused-usage-limit" ? `paused on the Claude usage limit during the verify fix round: ${fix.error ?? ""}` : fix.error;
    return fail(fix.status === "paused-usage-limit" ? "failed" : fix.status, { review: result, ...(error ? { error } : {}) });
  };
  const verifyStep = (extra?: Partial<IssueResult>) => runVerify(ctx, { verify, verifyOnHost, verifyNetwork, sandbox, setup, result, retries: extra ? 0 : verifyRetries ?? 1, fixRound }, extra);
  const failedVerify = await verifyStep();
  if (failedVerify) return failedVerify;

  return publishIssue(ctx, { agent, reviewer, verify, verifySource, merge, manual, handoff, mergeTurn, ciTimeoutMin, ciPollMs, result, notFiled, remoteSha, baseSha, runVerify: verifyStep });
}
