import { pickFollowUps } from "../core/structured.ts";
import { issueBranch, markBlocked, type IssueInfo } from "../github/issues.ts";
import { markTrust } from "../github/trust.ts";
import { claimRemoteBranch, waitForMerge } from "../github/branches.ts";
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { neutralise, redact } from "../core/redact.ts";
import { parseConfig } from "../core/config.ts";
import { copyIntoWorktree, copyPatterns } from "../worktree/copy.ts";
import { emit, emitStage, hyperlink, type OnEvent } from "../core/events.ts";
import { tailLines, testCounts } from "../core/output.ts";
import { failureReason } from "../core/reason.ts";
import { modelLabel } from "../agents/models.ts";
import { loadPromptTemplate, renderPrompt } from "./prompt.ts";
import type { Pause } from "./errors.ts";
import { review } from "./review.ts";
import { runSetup, worktreeAdmin } from "../worktree/admin.ts";
import { isolatedEnv } from "../sandboxes/env.ts";
import { stepLimits, timeoutMessage } from "../sandboxes/exec.ts";
import type { Usage } from "../agents/agent.ts";
import type { IssueOptions, IssueResult } from "./issue.ts";
import { reclaimLeftover, track } from "./issue-cleanup.ts";
import { ISSUE_CONVENTION, ISSUE_PROMPT, MAX_FOLLOW_UPS, REVIEWER_CONVENTION, VERIFY_TAIL, collectFollowUps, commentsSection, issueSection, notFiledLines, reviewLines } from "./issue-prompt.ts";

export async function runIssueInner({ issue: number, cwd = process.cwd(), agent, reviewer, sandbox, maxRounds, resume, setup, copyToWorktree, verify, verifyOnHost, verifyNetwork, merge, ciTimeoutMin = 30, ciPollMs = 10_000, onEvent: rawOnEvent, mergeTurn, attempt = 1, queueOrder, mention, ...timeouts }: IssueOptions, spent: { usage?: Usage }, setUntrack: (u: () => void) => void): Promise<IssueResult> {
  const onEvent: OnEvent | undefined = rawOnEvent && ((e) => rawOnEvent({ ...e, issue: number }));
  // With BUNKER_GH_TOKEN, gh runs as that scoped token and git talks HTTPS through gh's
  // credential helper, so neither the user's SSH key nor their gh login is used.
  const token = process.env.BUNKER_GH_TOKEN;
  const env = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
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
    else if (status !== "pr-opened" && status !== "needs-review") {
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
  // Default verify: the base branch's .bunker/verify, read now so the agent can't weaken it in its worktree.
  let verifySource = "--verify";
  if (!verify) {
    const show = async (path: string) => {
      const f = await $`git -C ${repo} show ${`${baseSha}:${path}`}`.nothrow().quiet();
      return f.exitCode === 0 ? f.stdout.toString() : undefined;
    };
    let fromToml: string | undefined;
    try {
      const toml = await show(".bunker/config.toml");
      fromToml = toml === undefined ? undefined : parseConfig(toml).config.verify;
    } catch (e) {
      return fail("failed", { error: e instanceof Error ? e.message : String(e) });
    }
    const legacy = (await show(".bunker/verify"))?.trim();
    if (fromToml?.trim()) {
      verify = fromToml.trim();
      verifySource = ".bunker/config.toml";
    } else if (legacy) {
      verify = legacy;
      verifySource = ".bunker/verify";
    }
  }
  if (merge && !verify) return fail("failed", { error: "merge requires --verify, verify in .bunker/config.toml or a .bunker/verify file" });
  if (verifyOnHost && !verify) return fail("failed", { error: "--verify-on-host requires --verify, verify in .bunker/config.toml or a .bunker/verify file" });
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

  // Issue text goes in as {{ISSUE}}/{{COMMENTS}} values, so it is never expanded; `!\`cmd\`` only runs from the template.
  let prompt: string;
  try {
    const originUrl = (await $`git -C ${repo} remote get-url origin`.nothrow().quiet().text()).trim();
    const repoName = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(originUrl)?.[1] ?? basename(repo);
    prompt = await renderPrompt(await loadPromptTemplate(repo, fetched.sha, "issue", ISSUE_PROMPT), {
      cwd: worktree,
      vars: {
        ISSUE_NUMBER: String(number), ISSUE_TITLE: issue.title, BRANCH: branch, REPO: repoName, BASE: defaultBranch,
        ISSUE: issueSection(number, issue), COMMENTS: commentsSection(issue.comments), CONVENTION: ISSUE_CONVENTION,
      },
    });
  } catch (e) {
    return fail("failed", { error: e instanceof Error ? e.message : String(e) });
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
    return finish("paused-usage-limit", { review: result, pause: { ...(result.pause.resetAt !== undefined ? { resetAt: result.pause.resetAt } : {}), ...(result.pause.sessionId ? { sessionId: result.pause.sessionId } : {}) } });
  }
  rmSync(pausedFile, { force: true });

  for (const [i, r] of result.rounds.entries()) {
    log(`round ${i + 1}: agent output`, r.output);
    log(`round ${i + 1}: reviewer output (${r.approved ? "approved" : "changes requested"})`, r.feedback);
  }
  if (result.error) log("review error", result.error);

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
    const created = await $`gh issue create --label discovered --title ${neutralise(blocker.title)} --body ${`${neutralise(blocker.body)}\n\nBlocks #${number}.`}`.cwd(cwd).env(env).nothrow().quiet();
    const m = created.exitCode === 0 ? /\/issues\/(\d+)/.exec(created.stdout.toString()) : null;
    if (!m) {
      log(`gh issue create failed: ${blocker.title}`, created.stderr.toString());
    } else {
      const blockedBy = { number: Number(m[1]), title: blocker.title };
      await markBlocked(number, blockedBy, cwd, env, mention);
      await worktreeAdmin(repo, () => $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet());
      await worktreeAdmin(repo, () => $`git -C ${repo} branch -D ${branch}`.nothrow().quiet());
      emit(onEvent, { type: "note", text: `blocked by #${blockedBy.number}: ${blockedBy.title}` });
      return fail("blocked", { review: result, blockedBy });
    }
  }
  if (result.status !== "approved") return fail(result.status, { review: result, ...(result.error ? { error: result.error } : {}) });

  /** Setup + verify in the worktree; a failed result, or undefined when verify passed (or there is none). */
  const runVerify = async (extra: Partial<IssueResult> = {}): Promise<IssueResult | undefined> => {
    if (!verify) return undefined;
    emitStage({ onEvent }, "verify");
    // The issue worktree is a fresh checkout too (the agent ran in review()'s own), so it needs setup as well.
    const prep = await runSetup(sandbox, { worktree, gitCommonDir }, setup, timeouts);
    if (prep) {
      log(`setup (exit ${prep.code})`, prep.stdout);
      if (prep.timedOut) {
        const error = timeoutMessage("setup", prep.timedOut, timeouts);
        failNote(error, prep.stdout);
        return fail("idle-timeout", { review: result, ...extra, error });
      }
      if (prep.code !== 0) {
        failNote(`setup failed (exit ${prep.code})`, prep.stdout);
        return fail("failed", { review: result, ...extra, error: `setup failed (exit ${prep.code}):\n${tailLines(prep.stdout).slice(-VERIFY_TAIL)}` });
      }
    }
    let code: number;
    let text: string;
    let timedOut: "idle" | "step" | undefined;
    const verifyStart = Date.now();
    if (verifyOnHost) {
      // Own process group (setsid) so a timeout kills the whole tree, not just the shell.
      // Agent-written code on the host: no GitHub tokens, no Claude credentials.
      const proc = Bun.spawn(["setsid", "sh", "-c", verify], { cwd: worktree, env: isolatedEnv(), stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => {
        timedOut = "step";
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      }, stepLimits(timeouts).stepMs);
      try {
        const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        code = proc.exitCode ?? 1;
        text = o + e;
      } finally {
        clearTimeout(timer);
      }
    } else {
      // Agent-written code: same sandbox as the agent, no GitHub tokens, and (unless opted in) no network
      // or Claude credentials. stderr folded in so we can report it.
      const out = await sandbox.exec(["sh", "-c", `(${verify}) 2>&1`], { worktree, gitCommonDir, limits: stepLimits(timeouts), isolate: !verifyNetwork });
      timedOut = out.timedOut;
      code = out.code;
      text = out.stdout;
    }
    log(`verify (exit ${code})`, text);
    if (timedOut) {
      const error = timeoutMessage("verify", timedOut, timeouts);
      failNote(error, text);
      return fail("idle-timeout", { review: result, ...extra, error, verifyOutput: tailLines(text).slice(-VERIFY_TAIL) });
    }
    if (code !== 0) {
      failNote(`verify failed (exit ${code})`, text);
      return fail("verify-failed", { review: result, ...extra, verifyOutput: tailLines(text).slice(-VERIFY_TAIL) });
    }
    const counts = testCounts(text);
    emit(onEvent, { type: "note", text: `verify passed (${[counts, `${((Date.now() - verifyStart) / 1000).toFixed(1)}s`].filter(Boolean).join(", ")})` });
    return undefined;
  };
  const failedVerify = await runVerify();
  if (failedVerify) return failedVerify;

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
