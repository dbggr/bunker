import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { capSources, capsFrom, resolveCiTimeout, resolveParallel, resolveWatchSettings } from "../src/core/settings.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const cfg = { interval: 5, parallel: 3, max_cost_day: 10, max_cost_month: 100, audit_every: 30, triage_every: 12 };

describe("watch settings: CLI flag over config.toml", () => {
  test("config values apply when no flag is given", () => {
    expect(resolveWatchSettings({}, cfg, {})).toEqual({ intervalMin: 5, caps: { day: 10, month: 100 }, auditEveryDays: 30, triageEveryHours: 12 });
  });

  test("--interval overrides watch.interval", () => {
    expect(resolveWatchSettings({ interval: "2" }, cfg, {}).intervalMin).toBe(2);
  });

  test("--max-cost-day and --max-cost-month override the config caps", () => {
    const r = resolveWatchSettings({ "max-cost-day": "1.5", "max-cost-month": "20" }, cfg, {});
    expect(r.caps).toEqual({ day: 1.5, month: 20 });
  });

  test("--max-cost is not an alias of --max-cost-day", () => {
    expect(resolveWatchSettings({ "max-cost": "3" }, cfg, {}).caps.day).not.toBe(3);
  });

  test("--audit-every overrides watch.audit_every", () => {
    expect(resolveWatchSettings({ "audit-every": "7" }, cfg, {}).auditEveryDays).toBe(7);
  });

  test("--triage-every overrides watch.triage_every", () => {
    expect(resolveWatchSettings({ "triage-every": "6" }, cfg, {}).triageEveryHours).toBe(6);
    expect(() => resolveWatchSettings({ "triage-every": "0" }, cfg, {})).toThrow("--triage-every");
  });

  test("a flag beats the user-level spend caps file too", () => {
    expect(resolveWatchSettings({ "max-cost-day": "4" }, cfg, { day: 50 }).caps.day).toBe(4);
  });

  test("the repo's watch caps beat the user-level spend caps file (#482)", () => {
    expect(resolveWatchSettings({}, cfg, { day: 20, month: 500 }).caps).toEqual({ day: 10, month: 100 });
  });

  test("the user-level caps apply where the repo sets none, per window", () => {
    expect(resolveWatchSettings({}, { max_cost_day: 10 }, { day: 20, month: 500 }).caps).toEqual({ day: 10, month: 500 });
    expect(resolveWatchSettings({}, {}, { day: 20 }).caps).toEqual({ day: 20 });
  });

  test("capSources says where each window's cap comes from, for doctor", () => {
    expect(capSources(cfg, { day: 20 })).toEqual({ day: "repo", month: "repo" });
    expect(capSources({ max_cost_day: 10 }, { month: 500 })).toEqual({ day: "repo", month: "user" });
    expect(capSources({}, {})).toEqual({});
  });

  test("status and watch merge caps the same way: flag, then repo, then user", () => {
    expect(capsFrom(cfg, { day: 20, month: 500 })).toEqual({ day: 10, month: 100 });
    expect(capsFrom({}, { day: 20 })).toEqual({ day: 20 });
    expect(capsFrom({ max_cost_month: 70 }, {})).toEqual({ month: 70 });
  });

  test("invalid flag values are rejected rather than falling back to config", () => {
    expect(() => resolveWatchSettings({ interval: "0" }, cfg, {})).toThrow("--interval");
    expect(() => resolveWatchSettings({ "max-cost-month": "x" }, cfg, {})).toThrow("--max-cost-month");
    expect(() => resolveWatchSettings({ "audit-every": "-1" }, cfg, {})).toThrow("--audit-every");
  });
});

describe("--parallel over watch.parallel", () => {
  test("config applies to --watch only", () => {
    expect(resolveParallel({ watch: true }, cfg)).toBe(3);
    expect(resolveParallel({}, cfg)).toBe(1);
  });

  test("the flag overrides config", () => {
    expect(resolveParallel({ watch: true, parallel: "2", queue: true, merge: true }, cfg)).toBe(2);
  });

  test("above 1 needs --merge, --watch or manual-merge mode", () => {
    expect(() => resolveParallel({ queue: true, parallel: "2" }, cfg)).toThrow("--parallel");
    expect(resolveParallel({ queue: true, parallel: "2" }, cfg, true)).toBe(2);
    expect(resolveParallel({ watch: true, queue: true, parallel: "2" }, cfg, true)).toBe(2);
  });

  test("an invalid flag is rejected", () => {
    expect(() => resolveParallel({ watch: true, parallel: "0", queue: true, merge: true }, cfg)).toThrow("--parallel");
  });
});

describe("--ci-timeout over merge.ci_timeout", () => {
  test("config applies only when merging", () => {
    expect(resolveCiTimeout({ merge: true }, { ci_timeout: 45 })).toBe(45);
    expect(resolveCiTimeout({}, { ci_timeout: 45 })).toBeUndefined();
  });

  test("the flag overrides config", () => {
    expect(resolveCiTimeout({ merge: true, "ci-timeout": "10" }, { ci_timeout: 45 })).toBe(10);
  });

  test("an invalid flag, or one without --merge, is rejected", () => {
    expect(() => resolveCiTimeout({ merge: true, "ci-timeout": "0" }, { ci_timeout: 45 })).toThrow("--ci-timeout");
    expect(() => resolveCiTimeout({ "ci-timeout": "5" }, { ci_timeout: 45 })).toThrow("--ci-timeout");
  });
});
