import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { combine, parseRun, resolveRun, section4, totalsFor, wrongMergedPrs, type PrState } from "../scripts/v1-readiness-lib.ts";

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
});
