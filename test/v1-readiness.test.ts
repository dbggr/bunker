import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { combine, failedLabelsOf, handCommitState, handCommitsLine, parseRun, requeuesOf, resolveRun, section4, summariseHandCommits, totalsFor, wrongMergedPrs, type PrState } from "../scripts/v1-readiness-lib.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const log = (status: string, pr?: number) =>
  `== round 1 ==\n{"type":"result","total_cost_usd":0.5}\n== final status: ${status} ==\n${pr ? `https://github.com/o/r/pull/${pr}\n` : ""}`;
const run = (file: string, status: string, pr?: number) => parseRun(file, log(status, pr));
const prs = (...p: PrState[]) => new Map(p.map((x) => [x.number, x]));

describe("v1-readiness", () => {
  test("an awaiting-merge run whose PR merged counts as merged, and first-try", () => {
    const r = run("7-2026-10-19T10-00-00-000Z.log", "awaiting-merge", 70);
    expect(r.prNumber).toBe(70);
    const res = resolveRun(r, prs({ number: 70, state: "MERGED", mergedAt: "2026-10-19T11:00:00Z" }), new Set());
    expect(res.status).toBe("merged");
    const t = totalsFor("o/r", [res], { interventions: 0, bunkerMergedPrs: 1, wrongMerges: 0 });
    expect([t.mergedRuns, t.finishedRuns, t.issuesMerged, t.firstTry]).toEqual([1, 1, 1, 1]);
  });

  test("closed unmerged is a failure; an open PR is pending, not finished", () => {
    const closed = resolveRun(run("8-2026-10-19T10-00-00-000Z.log", "awaiting-merge", 80), prs({ number: 80, state: "CLOSED", mergedAt: null }), new Set());
    const open = resolveRun(run("9-2026-10-19T10-00-00-000Z.log", "awaiting-merge", 90), prs({ number: 90, state: "OPEN", mergedAt: null }), new Set());
    const t = totalsFor("o/r", [closed, open], { interventions: 0, bunkerMergedPrs: 0, wrongMerges: 0 });
    expect([closed.status, open.status]).toEqual(["closed-unmerged", "awaiting-merge"]);
    expect([t.finishedRuns, t.mergedRuns]).toEqual([1, 0]);
  });

  test("a merge that turned main red or was reverted is a failure", () => {
    const merged: PrState[] = [
      { number: 1, state: "MERGED", mergedAt: "x", mergeCommit: { oid: "abcdef123" } },
      { number: 2, state: "MERGED", mergedAt: "x", mergeCommit: { oid: "ffff" } },
    ];
    const wrong = wrongMergedPrs(merged, ["abcdef1"], ["Revert \"fix: b (#2)\""]);
    expect([...wrong].sort()).toEqual([1, 2]);
    expect(resolveRun(run("1-2026-10-19T10-00-00-000Z.log", "awaiting-merge", 1), prs(merged[0]!), wrong).status).toBe("wrong-merge");
  });

  test("first try fails when an earlier finished attempt failed", () => {
    const a = run("5-2026-10-19T09-00-00-000Z.log", "rejected");
    const b = run("5-2026-10-19T10-00-00-000Z.log", "merged");
    const t = totalsFor("o/r", [a, b], { interventions: 0, bunkerMergedPrs: 1, wrongMerges: 0 });
    expect([t.issuesMerged, t.firstTry]).toEqual([1, 0]);
  });

  test("§4 block has a column per repo plus combined", () => {
    const a = totalsFor("o/a", [run("1-2026-10-19T10-00-00-000Z.log", "merged")], { interventions: 0, bunkerMergedPrs: 1, wrongMerges: 0 });
    const b = totalsFor("o/b", [run("2-2026-10-19T10-00-00-000Z.log", "rejected")], { interventions: 1, bunkerMergedPrs: 0, wrongMerges: 0 });
    expect(combine([a, b]).finishedRuns).toBe(2);
    const md = section4([a, b]);
    expect(md.split("\n")[0]).toBe("| Metric | o/a | o/b | combined |");
    expect(md).toContain("1 / 2 (50%)");
  });

  describe("gated, no-change and blocked runs", () => {
    const zero = { interventions: 0, bunkerMergedPrs: 0, wrongMerges: 0 };
    const gated = (n: number, status: string) => run(`${n}-2026-10-19T10-00-00-000Z.log`, status, n * 10);
    const totals = (...rs: ReturnType<typeof run>[]) => totalsFor("o/r", rs, zero);

    test("needs-review / awaiting-review whose PR merged with no human commit is a success", () => {
      for (const status of ["needs-review", "awaiting-review"]) {
        const r = resolveRun(gated(1, status), prs({ number: 10, state: "MERGED", mergedAt: "x", humanCommits: false }), new Set());
        const t = totals(r);
        expect([r.status, t.successRuns, t.countedRuns, t.gatedRuns, t.interventions]).toEqual(["merged", 1, 1, 1, 0]);
      }
    });

    test("a gated PR a human pushed commits to is an intervention, neither success nor failure", () => {
      const r = resolveRun(gated(1, "needs-review"), prs({ number: 10, state: "MERGED", mergedAt: "x", humanCommits: true }), new Set());
      const t = totals(r);
      expect([r.status, t.successRuns, t.countedRuns, t.gatedRuns, t.interventions]).toEqual(["gated-intervened", 0, 0, 1, 1]);
    });

    test("a gated run still open or closed unmerged stays gated and out of the rate", () => {
      const open = resolveRun(gated(1, "needs-review"), prs({ number: 10, state: "OPEN", mergedAt: null }), new Set());
      const closed = resolveRun(gated(2, "awaiting-review"), prs({ number: 20, state: "CLOSED", mergedAt: null }), new Set());
      const t = totals(open, closed, run("3-2026-10-19T10-00-00-000Z.log", "merged"));
      expect([open.status, closed.status]).toEqual(["needs-review", "awaiting-review"]);
      expect([t.finishedRuns, t.countedRuns, t.successRuns, t.gatedRuns]).toEqual([3, 1, 1, 2]);
    });

    test("a gated PR that turned main red is a wrong merge", () => {
      expect(resolveRun(gated(1, "needs-review"), prs({ number: 10, state: "MERGED", mergedAt: "x" }), new Set([10])).status).toBe("wrong-merge");
    });

    test("no-change is a success", () => {
      const t = totals(run("1-2026-10-19T10-00-00-000Z.log", "no-change"), run("2-2026-10-19T10-00-00-000Z.log", "rejected"));
      expect([t.successRuns, t.countedRuns]).toEqual([1, 2]);
    });

    test("blocked is excluded from the denominator and counted in its own row", () => {
      const t = totals(run("1-2026-10-19T10-00-00-000Z.log", "merged"), run("2-2026-10-19T10-00-00-000Z.log", "blocked"));
      expect([t.successRuns, t.countedRuns, t.blockedRuns]).toEqual([1, 1, 1]);
    });

    test("§4 shows the success rate without them, plus gated and blocked rows", () => {
      const t = totals(run("1-2026-10-19T10-00-00-000Z.log", "merged"), run("2-2026-10-19T10-00-00-000Z.log", "blocked"), gated(3, "needs-review"));
      const md = section4([t]);
      expect(md).toContain("| 1 / 1 (100%) | 1 / 1 (100%) |");
      expect(md).toMatch(/\| Gated runs[^|]*\| 1 \| 1 \|/);
      expect(md).toMatch(/\| Blocked runs[^|]*\| 1 \| 1 \|/);
    });
  });
});

describe("interventions", () => {
  const ev = (event: string, name: string) => ({ event, label: { name } });

  test("re-queues are repeated bunker:queued labelling after the first, plus the old `bunker` name", () => {
    expect(requeuesOf([ev("labeled", "bunker:queued")])).toBe(0);
    expect(requeuesOf([ev("labeled", "bunker:queued"), ev("labeled", "bunker:queued"), ev("labeled", "bunker:queued")])).toBe(2);
    expect(requeuesOf([ev("labeled", "bunker"), ev("labeled", "bunker:queued")])).toBe(1); // history: renamed label
    expect(requeuesOf([ev("labeled", "bunker"), ev("labeled", "bunker")])).toBe(1);
    expect(requeuesOf([ev("labeled", "bunker:queued"), ev("unlabeled", "bunker:queued"), ev("labeled", "bunker:failed")])).toBe(0);
    expect(requeuesOf([])).toBe(0);
  });

  test("failed labels count bunker:failed and the old bunker-failed", () => {
    expect(failedLabelsOf([ev("labeled", "bunker:failed"), ev("labeled", "bunker-failed"), ev("labeled", "bunker:queued"), ev("unlabeled", "bunker:failed")])).toBe(2);
  });

  test("an interrupted run (a cancel or a stop) is an intervention", () => {
    const runs = [run("1-2026-10-19T10-00-00-000Z.log", "interrupted"), run("2-2026-10-19T10-00-00-000Z.log", "merged")];
    const t = totalsFor("o/r", runs, { interventions: 1, bunkerMergedPrs: 1, wrongMerges: 0 });
    expect(t.interventions).toBe(2);
  });

  describe("hand commits on bunker PRs", () => {
    const bunker = (n: number) => ({ sha: `b${n}`, message: `feat: thing\n\nBunker-Run: 7-2026-11-02T10-00-00-000Z` });
    const hand = { sha: "h1", message: "fix: tweak by hand" };
    const webFlow = { sha: "w1", message: "Merge branch 'main' into feature/7-x" };

    test("a commit without the trailer on a PR whose bunker commits carry it is one intervention", () => {
      expect(handCommitState([bunker(1), hand])).toBe("hand");
      expect(handCommitState([bunker(1), hand, { ...hand, sha: "h2" }])).toBe("hand"); // still one per PR
    });

    test("the Update branch button (a web-flow merge) counts as human", () => {
      expect(handCommitState([bunker(1), webFlow])).toBe("hand");
    });

    test("a legacy PR that a later bunker pass stamped is not a hand intervention", () => {
      expect(handCommitState([hand, { ...hand, sha: "h2" }, bunker(1)])).toBe("clean");
      expect(handCommitState([hand, webFlow, bunker(1), hand])).toBe("hand"); // a human commit after the first marked one still counts
    });

    test("a human commit after a marked one is a hand intervention", () => {
      expect(handCommitState([bunker(1), hand])).toBe("hand");
    });

    test("all commits marked → clean", () => {
      expect(handCommitState([bunker(1), bunker(2)])).toBe("clean");
    });

    test("a PR with no trailer at all predates the change: unknown, never guessed from identity", () => {
      expect(handCommitState([hand, { ...hand, sha: "h2" }])).toBe("unknown");
      expect(handCommitState([hand, webFlow])).toBe("unknown");
      expect(handCommitState([])).toBe("unknown");
    });

    test("the report line states the gap", () => {
      const s = summariseHandCommits([[bunker(1), hand], [bunker(2)], [hand], [webFlow, hand]]);
      expect(s).toEqual({ handCommitPrs: 1, unknownPrs: 2 });
      expect(handCommitsLine(s)).toBe("hand commits: 1 (2 PRs predate the trailer, not counted)");
    });
  });
});
