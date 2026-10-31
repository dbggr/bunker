import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reasonFromLog, failureReason } from "../src/core/reason.ts";
import { collectStatus, createStatusRecorder, formatStatus, retryCommand } from "../src/cli/commands/status.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "status-"));
  dirs.push(d);
  mkdirSync(join(d, ".bunker"), { recursive: true });
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const log = (...secs: [string, string][]) => secs.map(([t, x]) => `== ${t} ==\n${x}\n\n`).join("");

describe("reason extraction", () => {
  test("verify-failed with a type error → the first error line", () => {
    const l = log(["verify (exit 2)", "$ tsc --noEmit\nsrc/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(1,1): error TS1000: other"], ["final status: verify-failed", ""]);
    expect(reasonFromLog("verify-failed", l)).toBe("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  });

  test("verify-failed with a failing test → the first failing test", () => {
    const l = log(["verify (exit 1)", "test/a.test.ts:\n(pass) ok [1ms]\n(fail) widget > renders [12.00ms]\n(fail) other [1ms]\n 1 pass\n 2 fail"], ["final status: verify-failed", ""]);
    expect(reasonFromLog("verify-failed", l)).toBe("test failed: widget > renders");
  });

  test("rejected → the reviewer's first required change", () => {
    const l = log(["round 1: reviewer output (changes requested)", "- Add setDefaultTimeout to the new test file\n- Rename foo\n\nlong prose"], ["final status: rejected", ""]);
    expect(reasonFromLog("rejected", l)).toBe("Add setDefaultTimeout to the new test file");
  });

  test("idle-timeout → the error line", () => {
    const l = log(["final status: idle-timeout", "the implementer produced no output for 10 min (idle timeout)\nsecond line"]);
    expect(reasonFromLog("idle-timeout", l)).toBe("the implementer produced no output for 10 min (idle timeout)");
  });

  test("secrets are redacted, whitespace collapsed and the line capped", () => {
    const l = log(["final status: failed", `token ghp_${"a".repeat(30)}   ${"x".repeat(400)}`]);
    const r = reasonFromLog("failed", l);
    expect(r).not.toContain("ghp_");
    expect(r).toContain("[REDACTED]");
    expect(r.length).toBeLessThanOrEqual(200);
  });

  test("a missing log falls back to the result's own fields, then the status", () => {
    expect(failureReason("failed", "/nonexistent/log", { error: "boom\nmore" })).toBe("boom");
    expect(failureReason("verify-failed", undefined, { verifyOutput: "error TS1: bad" })).toBe("error TS1: bad");
    expect(failureReason("conflict", undefined)).toBe("conflict");
  });
});

describe("collectStatus()", () => {
  const dead = () => false;

  test("a stale lock is reported as not alive", async () => {
    const r = repo();
    writeFileSync(join(r, ".bunker", "watch.lock"), "999999");
    const s = await collectStatus({ repo: r, alive: dead });
    expect(s.watcher.alive).toBe(false);
    expect(s.watcher.stale).toBe(true);
    expect(s.watcher.pid).toBe(999999);
    expect(formatStatus(s)).toContain("stale lock");
  });

  test("no watcher ever → not alive, empty", async () => {
    const s = await collectStatus({ repo: repo(), alive: dead });
    expect(s.watcher).toEqual({ alive: false, stale: false });
    expect(s.failed).toEqual([]);
  });

  test("blocked issues are listed with what they wait on", async () => {
    const s = await collectStatus({ repo: repo(), alive: dead, blocked: async () => [{ number: 4, title: "Four", waitingOn: [9, 10] }, { number: 5, title: "Five", waitingOn: [] }] });
    expect(s.blocked).toEqual([{ number: 4, title: "Four", waitingOn: [9, 10] }, { number: 5, title: "Five", waitingOn: [] }]);
    const t = formatStatus(s);
    expect(t).toContain("#4 Four · waiting on #9, #10");
    expect(t).toContain("#5 Five");
  });

  test("a live watcher's own caps win over the configured ones", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    writeFileSync(join(dir, "watch.lock"), "4242");
    createStatusRecorder(dir, { pid: 4242, version: "x", caps: { day: 100 } });
    const live = await collectStatus({ repo: r, caps: { day: 20, month: 500 }, alive: () => true });
    expect(live.spend.day.capUsd).toBe(100);
    expect(live.spend.month.capUsd).toBeUndefined();
    const dead = await collectStatus({ repo: r, caps: { day: 20 }, alive: () => false });
    expect(dead.spend.day.capUsd).toBe(20);
  });

  test("a no-change run is listed with its reason, and is not a failure", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    const rec = createStatusRecorder(dir, { pid: 1, version: "x" });
    rec.failed({ issue: 9, status: "failed", reason: "empty change" });
    rec.noChange({ issue: 9, verdict: "fixed", reason: "already fixed in #12" });
    const s = await collectStatus({ repo: r, alive: () => false });
    expect(s.failed).toEqual([]);
    expect(s.merged).toEqual([]);
    expect(s.noChange).toEqual([{ issue: 9, verdict: "fixed", reason: "already fixed in #12", at: expect.any(Number) }]);
    expect(formatStatus(s)).toContain("#9 no-change (fixed): already fixed in #12");
  });

  test("a run that ends without a terminal stage event (merged, no-change, failed) leaves the current runs", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    writeFileSync(join(dir, "watch.lock"), "4242");
    const rec = createStatusRecorder(dir, { pid: 4242, version: "x" });
    for (const n of [1, 2, 3, 4]) {
      rec.event({ type: "meta", issue: n, logPath: `/l/${n}.log`, at: 1 });
      rec.event({ type: "stage", name: "waiting for merge", issue: n, at: 2 });
    }
    rec.merged({ issue: 1 });
    rec.noChange({ issue: 2, verdict: "fixed", reason: "r" });
    rec.failed({ issue: 3, status: "gave-up", reason: "r" });
    const s = await collectStatus({ repo: r, alive: () => true });
    expect(s.current.map((c) => c.issue)).toEqual([4]);
  });

  test("a waiting-for-merge event arriving after the PR already merged does not list the run as in flight", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    writeFileSync(join(dir, "watch.lock"), "4242");
    const rec = createStatusRecorder(dir, { pid: 4242, version: "x" });
    rec.event({ type: "meta", issue: 101, logPath: "/l/101.log", at: 1 });
    rec.merged({ issue: 101 });
    rec.event({ type: "stage", name: "waiting for merge", issue: 101, at: 3 });
    expect((await collectStatus({ repo: r, alive: () => true })).current).toEqual([]);
    // a fresh run of the same issue (reopened) is tracked again
    rec.event({ type: "meta", issue: 101, logPath: "/l/101b.log", at: 4 });
    rec.event({ type: "stage", name: "waiting for merge", issue: 101, at: 5 });
    expect((await collectStatus({ repo: r, alive: () => true })).current.map((c) => c.issue)).toEqual([101]);
  });

  test("shepherd decisions replace the previous list and show in the report", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    writeFileSync(join(dir, "watch.lock"), "4242");
    const rec = createStatusRecorder(dir, { pid: 4242, version: "x" });
    rec.shepherd([{ issue: 4, pr: 9, prUrl: "https://github.com/o/r/pull/9", action: "waiting", detail: "no required checks reported" }]);
    rec.shepherd([{ issue: 4, pr: 9, prUrl: "https://github.com/o/r/pull/9", action: "skipped", detail: "a draft" }]);
    const s = await collectStatus({ repo: r, alive: () => true });
    expect(s.shepherd).toEqual([expect.objectContaining({ issue: 4, pr: 9, action: "skipped", detail: "a draft" })]);
    expect(formatStatus(s)).toContain("#4 PR #9 skipped: a draft");
  });

  test("JSON shape with a live watcher", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    writeFileSync(join(dir, "watch.lock"), "4242");
    const rec = createStatusRecorder(dir, { pid: 4242, version: "1.2.3" });
    const t0 = Date.now();
    rec.event({ type: "meta", issue: 7, logPath: "/l/7.log", at: t0 });
    rec.event({ type: "stage", name: "implement", issue: 7, at: t0 });
    rec.event({ type: "stage", name: "verify", issue: 7, at: t0 + 5000 });
    rec.merged({ issue: 3, prUrl: "https://github.com/o/r/pull/9" });
    rec.failed({ issue: 5, status: "verify-failed", reason: "src/a.ts(1,1): error TS1: x", logPath: "/l/5.log" });
    writeFileSync(join(dir, "watch-spend.json"), JSON.stringify([{ at: Date.now() - 1000, usd: 2.5 }]));
    const now = t0 + 60_000;
    const s = await collectStatus({
      repo: r, alive: (p) => p === 4242, caps: { day: 10 }, now,
      queue: async () => [
        { number: 11, title: "low one", createdAt: "2026-01-01T00:00:00Z", labels: [{ name: "priority:low" }] },
        { number: 12, title: "bug", createdAt: "2026-01-02T00:00:00Z", labels: [{ name: "bug" }, { name: "priority:high" }] },
      ],
    });
    expect(JSON.parse(JSON.stringify(s))).toEqual({
      watcher: { alive: true, stale: false, pid: 4242, version: "1.2.3", startedAt: expect.any(Number), uptimeMs: expect.any(Number) },
      current: [{ issue: 7, stage: "verify", sinceMs: 55_000, logPath: "/l/7.log" }],
      queue: [
        { number: 12, title: "bug", priority: "high", bug: true },
        { number: 11, title: "low one", priority: "low", bug: false },
      ],
      blocked: null,
      merged: [{ issue: 3, prUrl: "https://github.com/o/r/pull/9", at: expect.any(Number) }],
      noChange: [],
      shepherd: [],
      failed: [{ issue: 5, status: "verify-failed", reason: "src/a.ts(1,1): error TS1: x", logPath: "/l/5.log", at: expect.any(Number), retry: "gh issue edit 5 --remove-label bunker:failed --add-label bunker:queued" }],
      spend: { day: { spentUsd: 2.5, capUsd: 10 }, month: { spentUsd: 2.5 } },
    });
    const text = formatStatus(s);
    expect(text).toContain("watcher: alive · pid 4242 · 1.2.3");
    expect(text).toContain("#7 · verify for 55s");
    expect(text).toContain("1. #12 bug (high, bug)");
    expect(text).toContain("#5 verify-failed: src/a.ts(1,1): error TS1: x");
    expect(text).toContain(retryCommand(5));
    expect(text).toContain("$2.50 of $10");
  });

  test("a merge-unverified run is not offered for re-queueing", async () => {
    const r = repo();
    const rec = createStatusRecorder(join(r, ".bunker"), { pid: 1, version: "0.1.0" });
    rec.failed({ issue: 4, status: "merge-unverified", reason: "merged, but part of the PR's own change is missing", prUrl: "https://github.com/o/r/pull/9" });
    const s = await collectStatus({ repo: r, alive: () => false });
    expect(s.failed[0]?.retry).toBeUndefined();
    const text = formatStatus(s);
    expect(text).not.toContain("bunker:queued");
    expect(text).toContain("do not re-queue");
  });

  test("without a watcher the last run's results are still shown, and no run is current", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    const rec = createStatusRecorder(dir, { pid: 1, version: "0.1.0" });
    rec.event({ type: "stage", name: "implement", issue: 2, at: 1 });
    rec.failed({ issue: 2, status: "rejected", reason: "fix it" });
    const s = await collectStatus({ repo: r, alive: dead });
    expect(s.watcher.alive).toBe(false);
    expect(s.current).toEqual([]);
    expect(s.failed.map((f) => f.reason)).toEqual(["fix it"]);
  });

  test("an issue drops off the failed list once a later run merged it", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    const rec = createStatusRecorder(dir, { pid: 1, version: "x" });
    rec.failed({ issue: 280, status: "verify-failed", reason: "x" });
    rec.failed({ issue: 281, status: "verify-failed", reason: "y" });
    rec.merged({ issue: 280 });
    const s = await collectStatus({ repo: r, alive: dead });
    expect(s.failed.map((f) => f.issue)).toEqual([281]);
  });

  test("a failure older than a merge in the status file is not listed", async () => {
    const r = repo();
    const dir = join(r, ".bunker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "watch-status.json"),
      JSON.stringify({
        pid: 1,
        version: "x",
        startedAt: 1,
        current: [],
        merged: [{ issue: 280, at: 20 }],
        failed: [{ issue: 280, status: "verify-failed", reason: "x", at: 10 }, { issue: 7, status: "failed", reason: "z", at: 10 }],
      }),
    );
    const s = await collectStatus({ repo: r, alive: dead });
    expect(s.failed.map((f) => f.issue)).toEqual([7]);
  });

  test("a run that finishes leaves the current list", () => {
    const r = repo();
    const dir = join(r, ".bunker");
    const rec = createStatusRecorder(dir, { pid: 1, version: "x" });
    rec.event({ type: "stage", name: "implement", issue: 2, at: 1 });
    rec.event({ type: "stage", name: "failed", issue: 2, at: 2 });
    return collectStatus({ repo: r, alive: () => true }).then((s) => expect(s.current).toEqual([]));
  });
});

test("the status recorder shows which verify attempt a run is on", () => {
  const dir = mkdtempSync(join(tmpdir(), "bunker-status-"));
  const rec = createStatusRecorder(dir, { pid: 1, version: "0.1.0" });
  rec.event({ type: "stage", name: "verify", text: "attempt 1/2", issue: 7, at: 1 });
  rec.event({ type: "stage", name: "verify", text: "attempt 2/2", issue: 7, at: 2 });
  expect(JSON.parse(readFileSync(join(dir, "watch-status.json"), "utf8")).current[0].stage).toBe("verify (attempt 2/2)");
  rmSync(dir, { recursive: true, force: true });
});

describe("createStatusRecorder() persistence", () => {
  test("merged and failed records from the last seven days survive a restart; older ones do not", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunker-status-"));
    const a = createStatusRecorder(dir, { pid: 1, version: "x" });
    a.merged({ issue: 1, at: Date.now() - 86_400_000 });
    a.merged({ issue: 2, at: Date.now() - 8 * 86_400_000 });
    a.failed({ issue: 3, status: "closed-unmerged", reason: "r" });
    const seen: any[] = [];
    createStatusRecorder(dir, { pid: 2, version: "x" }, (w) => seen.push(w));
    const file = JSON.parse(readFileSync(join(dir, "watch-status.json"), "utf8"));
    expect(file.merged.map((m: any) => m.issue)).toEqual([1]);
    expect(file.failed.map((m: any) => m.issue)).toEqual([3]);
    expect(seen[0].merged).toHaveLength(1);
  });
});

describe("createStatusRecorder() change feed", () => {
  test("publishes the watcher snapshot with parallel and the next pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunker-status-"));
    const seen: any[] = [];
    const rec = createStatusRecorder(dir, { pid: 1, version: "9", parallel: 3 }, (w) => seen.push(w));
    rec.nextPass(123);
    rec.merged({ issue: 4 });
    expect(seen[0]).toMatchObject({ version: "9", parallel: 3, merged: [] });
    expect(seen[1].nextPassAt).toBe(123);
    expect(seen[2].merged.map((m: any) => m.issue)).toEqual([4]);
  });
});
