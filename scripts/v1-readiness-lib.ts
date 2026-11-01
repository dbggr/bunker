/** Pure parts of scripts/v1-readiness.ts (run-log parsing, outcome resolution, the §4 table), kept apart so they can be tested. */
import { reasonFromLog } from "../src/core/reason.ts";
import { hasRunTrailer } from "../src/worktree/trailer.ts";

export interface LabelEvent { event: string; label?: { name: string } }

const labelled = (evs: LabelEvent[], names: string[]) => evs.filter((e) => e.event === "labeled" && e.label && names.includes(e.label.name)).length;

/** Times a human re-queued an issue: `bunker:queued` (or its old name `bunker`) added again after the first. */
export const requeuesOf = (evs: LabelEvent[]) => Math.max(0, labelled(evs, ["bunker:queued", "bunker"]) - 1);

/** Times an issue was labelled failed: `bunker:failed`, or its old name `bunker-failed`. */
export const failedLabelsOf = (evs: LabelEvent[]) => labelled(evs, ["bunker:failed", "bunker-failed"]);

export interface PrCommit { sha: string; message: string }

/**
 * Did a human push to a bunker PR? Bunker marks every commit it makes with a `Bunker-Run` trailer, so once a PR has one, any commit
 * without it (a hand push, GitHub's "Update branch" merge) is a human's. A PR with no trailer at all predates the marking and is
 * "unknown": bunker's commits and the maintainer's shared one identity then, so nothing is guessed.
 */
export function handCommitState(commits: PrCommit[]): "hand" | "clean" | "unknown" {
  const marked = commits.filter((c) => hasRunTrailer(c.message)).length;
  if (!marked) return "unknown";
  return marked < commits.length ? "hand" : "clean";
}

/** One intervention per PR with hand commits; PRs that predate the trailer are counted apart. */
export function summariseHandCommits(prs: PrCommit[][]) {
  const states = prs.map(handCommitState);
  return { handCommitPrs: states.filter((x) => x === "hand").length, unknownPrs: states.filter((x) => x === "unknown").length };
}

export const handCommitsLine = (s: { handCommitPrs: number; unknownPrs: number }) => `hand commits: ${s.handCommitPrs} (${s.unknownPrs} PRs predate the trailer, not counted)`;

export interface Run {
  issue: number;
  startedAt: string;
  status: string; // "incomplete" when the log has no final status (interrupted or still running)
  loggedStatus: string; // what the log said, before resolving awaiting-merge against GitHub
  prNumber?: number;
  reason?: string;
  rounds: number;
  costUsd: number;
  verifyFailed: boolean;
  leftoverKept: boolean;
}

export interface PrState {
  number: number;
  state: string;
  mergedAt: string | null;
  mergeCommit?: { oid: string } | null;
  /** A human pushed commits to the PR branch (not just approved/merged it). Unset when unknown. */
  humanCommits?: boolean;
}

/** Runs that correctly stopped for a human: the PR touches a review path (needs-review) or manual-merge mode (awaiting-review). */
export const isGatedLogged = (status: string) => status === "needs-review" || status === "awaiting-review";

/** reasonFromLog, plus the line that explains a reason ending in ':' (e.g. "could not create worktree:" → the git error). */
export function fullReason(status: string, text: string): string {
  const r = reasonFromLog(status, text);
  if (!r.endsWith(":")) return r;
  const at = text.lastIndexOf(r);
  const next = text.slice(at + r.length).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("{") && !l.startsWith("To ") && !l.startsWith("=="));
  return next ? `${r} ${next}` : r;
}

export function parseRun(file: string, text: string): Run {
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
  const pr = /\/pull\/(\d+)/.exec(text.slice(text.search(/^== final status:/m) >= 0 ? text.search(/^== final status:/m) : text.length));
  return {
    issue: Number(num),
    startedAt: stamp!.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"),
    status,
    loggedStatus: status,
    ...(pr ? { prNumber: Number(pr[1]) } : {}),
    ...(status !== "merged" && status !== "incomplete" ? { reason: fullReason(status, text) } : {}),
    rounds,
    costUsd,
    verifyFailed: /^== verify \(exit [1-9]/m.test(text),
    leftoverKept: /^== stale leftover kept/m.test(text),
  };
}

/**
 * Under `bunker watch` a run ends `awaiting-merge` (auto-merge armed) and GitHub merges the PR afterwards, so the log alone can't say
 * whether it succeeded. Settle it from the PR: merged → "merged", closed unmerged → "closed-unmerged", still open → stays "awaiting-merge"
 * (pending: not finished yet). A gated run (needs-review/awaiting-review) whose PR merged is "merged" if a human only approved/merged it,
 * "gated-intervened" if a human pushed commits; otherwise it stays gated. A merged PR whose commit turned main red, or was reverted, is "wrong-merge" for any run.
 */
export function resolveRun(run: Run, prs: Map<number, PrState>, wrongMerges: Set<number>): Run {
  if (run.prNumber !== undefined && wrongMerges.has(run.prNumber) && (run.status === "merged" || run.status === "awaiting-merge")) return { ...run, status: "wrong-merge" };
  if (isGatedLogged(run.status)) {
    const g = run.prNumber === undefined ? undefined : prs.get(run.prNumber);
    if (!g?.mergedAt) return run; // still waiting, or closed: stays gated
    if (wrongMerges.has(g.number)) return { ...run, status: "wrong-merge" };
    return { ...run, status: g.humanCommits ? "gated-intervened" : "merged" };
  }
  if (run.status !== "awaiting-merge") return run;
  const pr = run.prNumber === undefined ? undefined : prs.get(run.prNumber);
  if (!pr) return run;
  if (pr.mergedAt) return { ...run, status: "merged" };
  if (pr.state === "CLOSED") return { ...run, status: "closed-unmerged", reason: `PR #${pr.number} was closed without merging` };
  return run;
}

/** PR numbers whose merge commit has a red main CI run, or that a revert commit on main mentions. */
export function wrongMergedPrs(prs: PrState[], redShas: string[], revertSubjects: string[]): Set<number> {
  const out = new Set<number>();
  for (const p of prs) {
    if (!p.mergedAt) continue;
    const oid = p.mergeCommit?.oid;
    if (oid && redShas.some((s) => s === oid || oid.startsWith(s))) out.add(p.number);
    if (revertSubjects.some((s) => new RegExp(`#${p.number}\\b`).test(s))) out.add(p.number);
  }
  return out;
}

/** A run that has an outcome: not interrupted, not an armed PR still waiting on GitHub. */
export const isFinished = (r: Run) => r.status !== "incomplete" && r.status !== "awaiting-merge";

export interface Totals {
  repo: string;
  finishedRuns: number;
  /** Finished runs minus gated-and-not-cleanly-merged and blocked ones: the denominator of the success rate. */
  countedRuns: number;
  /** Runs counted as success: merged, no-change, and gated runs a human merged without a code change. */
  successRuns: number;
  /** Runs that ended needs-review/awaiting-review (whatever happened to the PR afterwards). */
  gatedRuns: number;
  blockedRuns: number;
  mergedRuns: number;
  issuesAttempted: number;
  issuesMerged: number;
  firstTry: number;
  interventions: number;
  wrongMerges: number;
  bunkerMergedPrs: number;
  costUsd: number;
}

export function totalsFor(repo: string, runs: Run[], extra: { interventions: number; bunkerMergedPrs: number; wrongMerges: number }): Totals {
  const byIssue = new Map<number, Run[]>();
  for (const r of runs) byIssue.set(r.issue, [...(byIssue.get(r.issue) ?? []), r]);
  const merged = [...byIssue.values()].filter((rs) => rs.some((r) => r.status === "merged"));
  const firstTry = merged.filter((rs) => rs.find(isFinished)?.status === "merged");
  const finished = runs.filter(isFinished);
  const intervened = finished.filter((r) => r.status === "gated-intervened");
  const counted = finished.filter((r) => r.status !== "blocked" && !isGatedLogged(r.status) && r.status !== "gated-intervened");
  return {
    repo,
    finishedRuns: finished.length,
    countedRuns: counted.length,
    successRuns: counted.filter((r) => r.status === "merged" || r.status === "no-change").length,
    gatedRuns: finished.filter((r) => isGatedLogged(r.loggedStatus)).length,
    blockedRuns: finished.filter((r) => r.status === "blocked").length,
    mergedRuns: finished.filter((r) => r.status === "merged").length,
    issuesAttempted: byIssue.size,
    issuesMerged: merged.length,
    firstTry: firstTry.length,
    ...extra,
    // A run a human cancelled or stopped (`bunker cancel`, Ctrl-C) ends `interrupted`.
    interventions: extra.interventions + intervened.length + finished.filter((r) => r.status === "interrupted").length,
    costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
  };
}

export function combine(rows: Totals[]): Totals {
  const sum = (f: (t: Totals) => number) => rows.reduce((a, t) => a + f(t), 0);
  return {
    repo: "combined",
    finishedRuns: sum((t) => t.finishedRuns),
    countedRuns: sum((t) => t.countedRuns),
    successRuns: sum((t) => t.successRuns),
    gatedRuns: sum((t) => t.gatedRuns),
    blockedRuns: sum((t) => t.blockedRuns),
    mergedRuns: sum((t) => t.mergedRuns),
    issuesAttempted: sum((t) => t.issuesAttempted),
    issuesMerged: sum((t) => t.issuesMerged),
    firstTry: sum((t) => t.firstTry),
    interventions: sum((t) => t.interventions),
    wrongMerges: sum((t) => t.wrongMerges),
    bunkerMergedPrs: sum((t) => t.bunkerMergedPrs),
    costUsd: sum((t) => t.costUsd),
  };
}

const pct = (n: number, d: number) => (d ? `${n} / ${d} (${Math.round((n / d) * 100)}%)` : `${n} / ${d}`);

/** The §4 table of release/v1-readiness.md, one column per repo plus a combined one, ready to paste. */
export function section4(rows: Totals[]): string {
  const cols = [...rows, combine(rows)];
  const line = (label: string, f: (t: Totals) => string) => `| ${label} | ${cols.map(f).join(" | ")} |`;
  return [
    `| Metric | ${cols.map((t) => t.repo).join(" | ")} |`,
    `|${" --- |".repeat(cols.length + 1)}`,
    line("Wrong merges: main red after a bunker merge, or a revert (bar 0)", (t) => String(t.wrongMerges)),
    line("Unattended success: (merged + no-change) / finished runs, gated and blocked excluded (bar ≥ 90%)", (t) => pct(t.successRuns, t.countedRuns)),
    line("Gated runs: stopped at a human-review path (needs-review / awaiting-review), not counted as failures", (t) => String(t.gatedRuns)),
    line("Blocked runs: waiting on another issue, excluded from the rate", (t) => String(t.blockedRuns)),
    line("Merged on the first finished attempt (bar ≥ 90%)", (t) => pct(t.firstTry, t.issuesMerged)),
    line("Human interventions per merged issue: re-queues + takeovers + cancelled runs + hand commits on bunker PRs (bar ≤ 0.10)", (t) => (t.issuesMerged ? `${(t.interventions / t.issuesMerged).toFixed(2)} (${t.interventions} over ${t.issuesMerged})` : "n/a")),
    line("Escapes per merged bunker PR: wrong merges only, add §3 by hand (bar ≤ 5%)", (t) => pct(t.wrongMerges, t.bunkerMergedPrs)),
    line("Cost per merged issue (bar ≤ $2)", (t) => (t.issuesMerged ? `$${(t.costUsd / t.issuesMerged).toFixed(2)}` : "n/a")),
  ].join("\n");
}
