#!/usr/bin/env bun
/**
 * Evidence for the v1.0 readiness review (#329): mines bunker's run logs and the repo's GitHub history.
 * Read-only. Re-run any time; numbers in release/v1-readiness.md come from its output.
 *
 *   bun scripts/v1-readiness.ts [--runs <dir>] [--repo <owner/name>] [--since <ISO date>] [--json] [--refresh]
 *
 * --runs defaults to .bunker/runs of the main checkout; GitHub answers are cached under $TMPDIR (--refresh drops them).
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { reasonFromLog } from "../src/core/reason.ts";

const { values } = parseArgs({
  options: { runs: { type: "string" }, repo: { type: "string" }, since: { type: "string" }, json: { type: "boolean" }, refresh: { type: "boolean" } },
});
const common = (await $`git rev-parse --path-format=absolute --git-common-dir`.text()).trim();
const runsDir = values.runs ?? join(common, "..", ".bunker", "runs");
const repo = values.repo ?? (await $`gh repo view --json nameWithOwner -q .nameWithOwner`.text()).trim();
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

// ---- runs (one log per runIssue attempt) ----
interface Run {
  issue: number;
  startedAt: string;
  status: string; // "incomplete" when the log has no final status (interrupted or still running)
  reason?: string;
  rounds: number;
  costUsd: number;
  verifyFailed: boolean;
  leftoverKept: boolean;
}

/** reasonFromLog, plus the line that explains a reason ending in ':' (e.g. "could not create worktree:" → the git error). */
function fullReason(status: string, text: string): string {
  const r = reasonFromLog(status, text);
  if (!r.endsWith(":")) return r;
  const at = text.lastIndexOf(r);
  const next = text.slice(at + r.length).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("{") && !l.startsWith("To ") && !l.startsWith("=="));
  return next ? `${r} ${next}` : r;
}

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
];
const classify = (status: string, reason = "") => CLASSES.find(([, re]) => re.test(`${status} ${reason}`) || re.test(reason))?.[0] ?? `other: ${status}`;

function parseRun(file: string): Run {
  const text = readFileSync(join(runsDir, file), "utf8");
  const [, num, stamp] = /^(\d+)-(.+)\.log$/.exec(file)!;
  const status = /^== final status: (\S+) ==$/m.exec(text)?.[1] ?? "incomplete";
  let costUsd = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === "result" && typeof j.total_cost_usd === "number") costUsd += j.total_cost_usd;
    } catch {}
  }
  const rounds = Math.max(0, ...[...text.matchAll(/^== round (\d+)/gm)].map((m) => Number(m[1])));
  return {
    issue: Number(num),
    startedAt: stamp!.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"),
    status,
    ...(status !== "merged" && status !== "incomplete" ? { reason: fullReason(status, text) } : {}),
    rounds,
    costUsd,
    verifyFailed: /^== verify \(exit [1-9]/m.test(text),
    leftoverKept: /^== stale leftover kept/m.test(text),
  };
}

const since = values.since ? new Date(values.since).toISOString() : "";
const runs = readdirSync(runsDir).filter((f) => /^\d+-.+\.log$/.test(f)).map(parseRun).filter((r) => r.startedAt >= since).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

// ---- GitHub: PRs, CI, re-queues ----
interface Pr { number: number; title: string; state: string; headRefName: string; body: string; createdAt: string; mergedAt: string | null }
const prs = await gh<Pr[]>("prs", ["pr", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number,title,state,headRefName,body,createdAt,mergedAt"]);
const BUNKER_PR = /^Round \d+: /m; // every PR body bunker writes has its review rounds; hand-written ones don't
const inWindow = prs.filter((p) => p.createdAt >= since);
const bunkerPrs = inWindow.filter((p) => BUNKER_PR.test(p.body));
const handPrs = inWindow.filter((p) => !BUNKER_PR.test(p.body));

interface WfRun { headBranch: string; conclusion: string; event: string; databaseId: number; createdAt: string }
const ci = await gh<WfRun[]>("ci", ["run", "list", "-R", repo, "--limit", "1000", "--json", "headBranch,conclusion,event,databaseId,createdAt"]);
const ciByBranch = new Map<string, WfRun[]>();
for (const r of ci) ciByBranch.set(r.headBranch, [...(ciByBranch.get(r.headBranch) ?? []), r]);

interface Ev { event: string; label?: { name: string }; actor?: { login: string }; created_at: string }
const issueNums = [...new Set([...runs.map((r) => r.issue), ...bunkerPrs.map((p) => Number(/Closes #(\d+)/i.exec(p.body)?.[1] ?? 0)).filter(Boolean)])].sort((a, b) => a - b);
const requeues = new Map<number, number>(); // times a human re-added `bunker` after the first
const failedLabels = new Map<number, number>();
for (const n of issueNums) {
  const evs = await gh<Ev[]>(`events-${n}`, ["api", "--paginate", `repos/${repo}/issues/${n}/events`]);
  const added = evs.filter((e) => e.event === "labeled" && e.label?.name === "bunker").length;
  requeues.set(n, Math.max(0, added - 1));
  failedLabels.set(n, evs.filter((e) => e.event === "labeled" && e.label?.name === "bunker-failed").length);
}

const reverts = (await $`git log --format=%h%x09%s ${since ? [`--since=${since}`] : []} origin/main`.text()).split("\n").filter((l) => /\trevert/i.test(l));
interface MainRun { conclusion: string; headSha: string; createdAt: string }
const mainRuns = (await gh<MainRun[]>("main-ci", ["run", "list", "-R", repo, "--branch", "main", "--limit", "1000", "--json", "conclusion,headSha,createdAt"])).filter((r) => r.createdAt >= since);

// ---- metrics ----
const count = <T>(xs: T[], f: (x: T) => string) => xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map<string, number>());
const finished = runs.filter((r) => r.status !== "incomplete");
const byIssue = new Map<number, Run[]>();
for (const r of runs) byIssue.set(r.issue, [...(byIssue.get(r.issue) ?? []), r]);
const issuesMerged = [...byIssue.values()].filter((rs) => rs.some((r) => r.status === "merged"));
const firstTry = issuesMerged.filter((rs) => rs.find((r) => r.status !== "incomplete")?.status === "merged");
const merged = bunkerPrs.filter((p) => p.mergedAt);
const hoursToMerge = merged.map((p) => (Date.parse(p.mergedAt!) - Date.parse(p.createdAt)) / 3_600_000).sort((a, b) => a - b);
const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);
const ciFailedBunkerPrs = bunkerPrs.filter((p) => (ciByBranch.get(p.headRefName) ?? []).some((r) => r.conclusion === "failure"));
const totalCost = runs.reduce((a, r) => a + r.costUsd, 0);

const report = {
  repo,
  window: { from: runs[0]?.startedAt, to: runs.at(-1)?.startedAt, logs: runs.length, note: "run logs exist from the first bunker issue runs that wrote them; earlier runs are only visible through their PRs" },
  runs: {
    total: runs.length,
    byStatus: Object.fromEntries([...count(runs, (r) => r.status)].sort((a, b) => b[1] - a[1])),
    successRate: finished.length ? runs.filter((r) => r.status === "merged").length / finished.length : 0,
    withSecondRound: finished.filter((r) => r.rounds >= 2).length,
    verifyFailedAtLeastOnce: finished.filter((r) => r.verifyFailed).length,
    incomplete: runs.filter((r) => r.status === "incomplete").map((r) => `#${r.issue} ${r.startedAt}`),
    leftoverKept: runs.filter((r) => r.leftoverKept).map((r) => `#${r.issue}`),
  },
  issues: {
    attempted: byIssue.size,
    merged: issuesMerged.length,
    mergedFirstTry: firstTry.length,
    requeuedByHuman: [...requeues].filter(([, n]) => n > 0).map(([i, n]) => `#${i}×${n}`),
    requeueTotal: [...requeues.values()].reduce((a, b) => a + b, 0),
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
    requeues: [...requeues.values()].reduce((a, b) => a + b, 0),
    takenOverByHand: handPrs.filter((p) => byIssue.has(Number(/Closes #(\d+)/i.exec(p.body)?.[1] ?? 0))).map((p) => `#${p.number}`),
  },
  cost: {
    totalUsd: Number(totalCost.toFixed(2)),
    perMergedIssueUsd: issuesMerged.length ? Number((totalCost / issuesMerged.length).toFixed(2)) : 0,
    perRunMedianUsd: Number(median(runs.map((r) => r.costUsd).sort((a, b) => a - b)).toFixed(2)),
  },
  failureClasses: Object.fromEntries([...count(finished.filter((r) => r.status !== "merged"), (r) => classify(r.status, r.reason))].sort((a, b) => b[1] - a[1])),
  failures: finished.filter((r) => r.status !== "merged").map((r) => ({ issue: r.issue, at: r.startedAt, status: r.status, class: classify(r.status, r.reason), reason: r.reason })),
};

if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  const p = (k: string, v: unknown) => console.log(`${k.padEnd(28)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  for (const [section, obj] of Object.entries(report)) {
    if (section === "failures") continue;
    console.log(`\n## ${section}`);
    if (Array.isArray(obj)) obj.forEach((x) => console.log(`  ${x}`));
    else if (typeof obj === "object" && obj) for (const [k, v] of Object.entries(obj)) p(`  ${k}`, v);
    else p("", obj);
  }
  console.log("\n## failures");
  for (const f of report.failures) console.log(`  #${f.issue} ${f.at.slice(0, 16)} ${f.status.padEnd(18)} [${f.class}] ${f.reason ?? ""}`.slice(0, 260));
}
