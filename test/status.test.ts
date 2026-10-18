import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      merged: [{ issue: 3, prUrl: "https://github.com/o/r/pull/9", at: expect.any(Number) }],
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

  test("a run that finishes leaves the current list", () => {
    const r = repo();
    const dir = join(r, ".bunker");
    const rec = createStatusRecorder(dir, { pid: 1, version: "x" });
    rec.event({ type: "stage", name: "implement", issue: 2, at: 1 });
    rec.event({ type: "stage", name: "failed", issue: 2, at: 2 });
    return collectStatus({ repo: r, alive: () => true }).then((s) => expect(s.current).toEqual([]));
  });
});
