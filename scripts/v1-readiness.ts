#!/usr/bin/env bun
/**
 * Evidence for the v1.0 readiness review (#329): mines bunker's run logs and the repo's GitHub history.
 * Read-only. Re-run any time; numbers in release/v1-readiness.md come from its output.
 *
 *   bun scripts/v1-readiness.ts [--runs <dir>]... [--repo <owner/name>]... [--since <ISO date>] [--json] [--refresh]
 *
 * --runs defaults to .bunker/runs of the main checkout. --runs/--repo may be repeated (or comma-separated) to measure several repos
 * in one go: the Nth --runs pairs with the Nth --repo. The last block is the §4 table (one column per repo plus combined).
 * A run that ends `awaiting-merge` is settled from its PR: merged counts as merged. GitHub answers are cached under $TMPDIR (--refresh drops them).
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { combine, failedLabelsOf, handCommitState, handCommitsLine, isFinished, isGatedLogged, parseRun, requeuesOf, resolveRun, section4, summariseHandCommits, totalsFor, wrongMergedPrs, type PrCommit, type PrState, type Totals } from "./v1-readiness-lib.ts";

const { values } = parseArgs({
  options: { runs: { type: "string", multiple: true }, repo: { type: "string", multiple: true }, since: { type: "string" }, json: { type: "boolean" }, refresh: { type: "boolean" } },
});
const list = (xs: string[] | undefined) => (xs ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
const common = (await $`git rev-parse --path-format=absolute --git-common-dir`.text()).trim();
const runsDirs = list(values.runs);
const repoNames = list(values.repo);
if (!runsDirs.length) runsDirs.push(join(common, "..", ".bunker", "runs"));
if (!repoNames.length) repoNames.push((await $`gh repo view --json nameWithOwner -q .nameWithOwner`.text()).trim());
if (runsDirs.length !== repoNames.length) {
  console.error(`got ${runsDirs.length} --runs but ${repoNames.length} --repo: give one run directory per repo, in the same order`);
  process.exit(2);
}
const since = values.since ? new Date(values.since).toISOString() : "";

/** Failure classes for the taxonomy; first match wins. */
const CLASSES: [string, RegExp][] = [
  ["workflow push refused (token has no Workflows permission)", /workflow `?\.github\/workflows/],
  ["agent code failed typecheck at verify", /error TS\d+/],
  ["agent code failed a test at verify", /^test failed|\(fail\)/],
  ["reviewer rejected after max rounds", /^rejected /],
  ["leftover branch after a restart", /branch named .* already exists/],
  ["docker image missing (deleted by a host test run, #295)", /setup failed \(exit 125\)/],
  ["merge plumbing before GitHub auto-merge (#63/#65)", /^(merge-failed|ci-unreadable) |CI checks still pending/],
  ["CI wait over the --ci-timeout", /^ci-timeout PR not merged after/],
  ["duplicate run (PR already open)", /^already-in-progress /],
  ["PR closed without merging", /^closed-unmerged /],
  ["merged, then main went red or the PR was reverted", /^wrong-merge/],
];
const classify = (status: string, reason = "") => CLASSES.find(([, re]) => re.test(`${status} ${reason}`) || re.test(reason))?.[0] ?? `other: ${status}`;
const count = <T>(xs: T[], f: (x: T) => string) => xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map<string, number>());
const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);

interface Pr extends PrState {
  author?: { login: string }; title: string; headRefName: string; body: string; createdAt: string }
interface WfRun { headBranch: string; conclusion: string; event: string; databaseId: number; createdAt: string }
interface Ev { event: string; label?: { name: string }; actor?: { login: string }; created_at: string }
interface MainRun { conclusion: string; headSha: string; createdAt: string }

async function analyze(runsDir: string, repo: string) {
  const cacheDir = join(tmpdir(), `bunker-v1-readiness-${repo.replace("/", "_")}`);
  if (values.refresh) rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });

  /** `gh` JSON, cached by key. */
  async function gh<T>(key: string, args: string[]): Promise<T> {
    const file = join(cacheDir, `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const out = await $`gh ${args}`.text();
    await Bun.write(file, out);
    return JSON.parse(out);
  }

  // ---- GitHub: PRs, CI, re-queues ----
  const prs = await gh<Pr[]>("prs", ["pr", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number,title,state,headRefName,body,createdAt,mergedAt,mergeCommit,author"]);
  const BUNKER_PR = /^Round \d+: /m; // every PR body bunker writes has its review rounds; hand-written ones don't
  const inWindow = prs.filter((p) => p.createdAt >= since);
  const bunkerPrs = inWindow.filter((p) => BUNKER_PR.test(p.body));
  const handPrs = inWindow.filter((p) => !BUNKER_PR.test(p.body));

  const ci = await gh<WfRun[]>("ci", ["run", "list", "-R", repo, "--limit", "1000", "--json", "headBranch,conclusion,event,databaseId,createdAt"]);
  const ciByBranch = new Map<string, WfRun[]>();
  for (const r of ci) ciByBranch.set(r.headBranch, [...(ciByBranch.get(r.headBranch) ?? []), r]);

  // Per repo: this checkout's git history says nothing about the other soak repos. One JSON object per line (--paginate would concatenate arrays).
  const commitsFile = join(cacheDir, "main-commits.jsonl");
  if (!existsSync(commitsFile)) {
    const q = ".[] | {sha, subject: (.commit.message | split(\"\\n\")[0])}";
    await Bun.write(commitsFile, await $`gh api --paginate ${`repos/${repo}/commits?sha=main&per_page=100${since ? `&since=${since}` : ""}`} --jq ${q}`.text());
  }
  const reverts = readFileSync(commitsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sha: string; subject: string }).filter((c) => /^revert/i.test(c.subject)).map((c) => `${c.sha.slice(0, 7)}\t${c.subject}`);
  const mainRuns = (await gh<MainRun[]>("main-ci", ["run", "list", "-R", repo, "--branch", "main", "--limit", "1000", "--json", "conclusion,headSha,createdAt"])).filter((r) => r.createdAt >= since);
  const redShas = mainRuns.filter((r) => r.conclusion === "failure").map((r) => r.headSha);
  const wrong = wrongMergedPrs(prs, redShas, reverts.map((l) => l.split("\t")[1]!));

  // A gated run's PR that merged: did a human push commits to it? (a commit author other than the PR author)
  const gatedPrNumbers = new Set(
    readdirSync(runsDir).filter((f) => /^\d+-.+\.log$/.test(f)).map((f) => parseRun(f, readFileSync(join(runsDir, f), "utf8"))).filter((r) => isGatedLogged(r.loggedStatus) && r.prNumber !== undefined).map((r) => r.prNumber!),
  );
  for (const p of prs) {
    if (!p.mergedAt || !gatedPrNumbers.has(p.number)) continue;
    const logins = await gh<(string | null)[]>(`pr-commits-${p.number}`, ["api", `repos/${repo}/pulls/${p.number}/commits?per_page=100`, "--jq", "[.[] | .author.login]"]);
    p.humanCommits = logins.some((l) => l !== null && l !== p.author?.login);
  }

  // ---- runs (one log per runIssue attempt), awaiting-merge settled from the PR ----
  const prByNumber = new Map(prs.map((p) => [p.number, p]));
  const runs = readdirSync(runsDir)
    .filter((f) => /^\d+-.+\.log$/.test(f))
    .map((f) => parseRun(f, readFileSync(join(runsDir, f), "utf8")))
    .filter((r) => r.startedAt >= since)
    .map((r) => resolveRun(r, prByNumber, wrong))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  for (const r of runs) if (r.status === "awaiting-merge") console.error(`warning: ${repo} #${r.issue} awaiting-merge ${r.prNumber === undefined ? "has no PR url in its log" : `PR #${r.prNumber} is open or not in the PR list`}; left out of the rates`);
  const issueNums = [...new Set([...runs.map((r) => r.issue), ...bunkerPrs.map((p) => Number(/Closes #(\d+)/i.exec(p.body)?.[1] ?? 0)).filter(Boolean)])].sort((a, b) => a - b);
  const requeues = new Map<number, number>(); // times a human re-added `bunker` after the first
  const failedLabels = new Map<number, number>();
  for (const n of issueNums) {
    const evs = await gh<Ev[]>(`events-${n}`, ["api", "--paginate", `repos/${repo}/issues/${n}/events`]);
    requeues.set(n, requeuesOf(evs));
    failedLabels.set(n, failedLabelsOf(evs));
  }

  // Hand commits on bunker PRs: only decidable for PRs whose bunker commits carry the Bunker-Run trailer (see handCommitState).
  const commitsByPr = new Map<number, PrCommit[]>();
  for (const p of bunkerPrs) commitsByPr.set(p.number, await gh<PrCommit[]>(`pr-commit-messages-${p.number}`, ["api", `repos/${repo}/pulls/${p.number}/commits?per_page=100`, "--jq", "[.[] | {sha, message: .commit.message}]"]));
  const handCommit = summariseHandCommits([...commitsByPr.values()]);
  const handCommitPrNumbers = bunkerPrs.filter((p) => handCommitState(commitsByPr.get(p.number)!) === "hand").map((p) => `#${p.number}`);

  // ---- metrics ----
  const finished = runs.filter(isFinished);
  const merged = bunkerPrs.filter((p) => p.mergedAt);
  const hoursToMerge = merged.map((p) => (Date.parse(p.mergedAt!) - Date.parse(p.createdAt)) / 3_600_000).sort((a, b) => a - b);
  const ciFailedBunkerPrs = bunkerPrs.filter((p) => (ciByBranch.get(p.headRefName) ?? []).some((r) => r.conclusion === "failure"));
  const takenOver = handPrs.filter((p) => runs.some((r) => r.issue === Number(/Closes #(\d+)/i.exec(p.body)?.[1] ?? 0)));
  const requeueTotal = [...requeues.values()].reduce((a, b) => a + b, 0);
  const totals = totalsFor(repo, runs, { interventions: requeueTotal + takenOver.length + handCommit.handCommitPrs, bunkerMergedPrs: merged.length, wrongMerges: merged.filter((p) => wrong.has(p.number)).length });
  const failed = finished.filter((r) => r.status !== "merged" && r.status !== "no-change" && r.status !== "blocked" && !isGatedLogged(r.status));

  const report = {
    repo,
    window: { from: runs[0]?.startedAt, to: runs.at(-1)?.startedAt, logs: runs.length, note: "run logs exist from the first bunker issue runs that wrote them; earlier runs are only visible through their PRs" },
    runs: {
      total: runs.length,
      byStatus: Object.fromEntries([...count(runs, (r) => r.status)].sort((a, b) => b[1] - a[1])),
      successRate: totals.countedRuns ? totals.successRuns / totals.countedRuns : 0,
      awaitingMerge: runs.filter((r) => r.status === "awaiting-merge").map((r) => `#${r.issue}`),
      withSecondRound: finished.filter((r) => r.rounds >= 2).length,
      verifyFailedAtLeastOnce: finished.filter((r) => r.verifyFailed).length,
      incomplete: runs.filter((r) => r.status === "incomplete").map((r) => `#${r.issue} ${r.startedAt}`),
      leftoverKept: runs.filter((r) => r.leftoverKept).map((r) => `#${r.issue}`),
    },
    issues: {
      attempted: totals.issuesAttempted,
      merged: totals.issuesMerged,
      mergedFirstTry: totals.firstTry,
      requeuedByHuman: [...requeues].filter(([, n]) => n > 0).map(([i, n]) => `#${i}×${n}`),
      requeueTotal,
      labelledFailed: [...failedLabels].filter(([, n]) => n > 0).map(([i, n]) => `#${i}×${n}`),
    },
    prs: {
      bunker: bunkerPrs.length,
      bunkerMerged: merged.length,
      bunkerClosedUnmerged: bunkerPrs.filter((p) => p.state === "CLOSED").map((p) => `#${p.number}`),
      bunkerOpen: bunkerPrs.filter((p) => p.state === "OPEN").map((p) => `#${p.number}`),
      hand: handPrs.map((p) => `#${p.number} ${p.title.slice(0, 70)}`),
      medianHoursToMerge: Number(median(hoursToMerge).toFixed(2)),
      bunkerPrsWithFailedCi: ciFailedBunkerPrs.map((p) => `#${p.number}`),
    },
    reverts,
    main: { ciRuns: mainRuns.length, red: mainRuns.filter((r) => r.conclusion === "failure").map((r) => `${r.headSha.slice(0, 7)} ${r.createdAt}`) },
    interventions: {
      requeues: requeueTotal,
      takenOverByHand: takenOver.map((p) => `#${p.number}`),
      cancelledOrInterruptedRuns: runs.filter((r) => r.status === "interrupted").map((r) => `#${r.issue} ${r.startedAt}`),
      handCommitPrs: handCommitPrNumbers,
      handCommits: handCommitsLine(handCommit),
    },
    cost: {
      totalUsd: Number(totals.costUsd.toFixed(2)),
      perMergedIssueUsd: totals.issuesMerged ? Number((totals.costUsd / totals.issuesMerged).toFixed(2)) : 0,
      perRunMedianUsd: Number(median(runs.map((r) => r.costUsd).sort((a, b) => a - b)).toFixed(2)),
    },
    failureClasses: Object.fromEntries([...count(failed, (r) => classify(r.status, r.reason))].sort((a, b) => b[1] - a[1])),
    failures: failed.map((r) => ({ issue: r.issue, at: r.startedAt, status: r.status, class: classify(r.status, r.reason), reason: r.reason })),
  };
  return { report, totals };
}

const results: { report: Awaited<ReturnType<typeof analyze>>["report"]; totals: Totals }[] = [];
for (const [i, repo] of repoNames.entries()) results.push(await analyze(runsDirs[i]!, repo));
const totalsRows = results.map((r) => r.totals);

if (values.json) {
  const out = results.length === 1 ? { ...results[0]!.report } : { repos: Object.fromEntries(results.map((r) => [r.report.repo, r.report])) };
  console.log(JSON.stringify({ ...out, section4: { repos: totalsRows, combined: combine(totalsRows), markdown: section4(totalsRows) } }, null, 2));
} else {
  const p = (k: string, v: unknown) => console.log(`${k.padEnd(28)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  for (const { report } of results) {
    console.log(`\n# ${report.repo}`);
    for (const [section, obj] of Object.entries(report)) {
      if (section === "failures" || section === "repo") continue;
      console.log(`\n## ${section}`);
      if (Array.isArray(obj)) obj.forEach((x) => console.log(`  ${x}`));
      else if (typeof obj === "object" && obj) for (const [k, v] of Object.entries(obj)) p(`  ${k}`, v);
      else p("", obj);
    }
    console.log("\n## failures");
    for (const f of report.failures) console.log(`  #${f.issue} ${f.at.slice(0, 16)} ${f.status.padEnd(18)} [${f.class}] ${f.reason ?? ""}`.slice(0, 260));
  }
  console.log("\n## §4 table (paste into release/v1-readiness.md)\n");
  console.log(section4(totalsRows));
}
