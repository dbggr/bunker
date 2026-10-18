import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, MONTH_MS, addSpend, capLiftsAt, exceededCaps, formatSpend, loadSpendCaps, spentWithin } from "../src/core/spend.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "spend-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const seed = (entries: { at: number; usd: number }[]) => {
  const f = join(tmp(), "watch-spend.json");
  writeFileSync(f, JSON.stringify(entries));
  return f;
};

describe("spend windows", () => {
  test("day and month windows are independent rolling sums", () => {
    const f = seed([{ at: Date.now() - 3 * DAY_MS, usd: 10 }, { at: Date.now() - 3_600_000, usd: 2 }, { at: Date.now() - 31 * DAY_MS, usd: 99 }]);
    expect(spentWithin(f, DAY_MS)).toBeCloseTo(2);
    expect(spentWithin(f, MONTH_MS)).toBeCloseTo(12);
  });

  test("monthly cap trips while the day cap does not", () => {
    const f = seed([{ at: Date.now() - 3 * DAY_MS, usd: 50 }]);
    const hit = exceededCaps(f, { day: 20, month: 40 });
    expect(hit.map((h) => h.window)).toEqual(["month"]);
    expect(capLiftsAt(f, MONTH_MS, 40)).toBeCloseTo(Date.now() + 27 * DAY_MS, -4);
  });

  test("day cap trips independently of the month cap", () => {
    const f = seed([{ at: Date.now() - 3_600_000, usd: 25 }]);
    expect(exceededCaps(f, { day: 20, month: 500 }).map((h) => h.window)).toEqual(["day"]);
  });

  test("no caps: never exceeded, still reported", () => {
    const f = seed([{ at: Date.now() - 1000, usd: 1000 }]);
    expect(exceededCaps(f, {})).toEqual([]);
    expect(formatSpend(f, {})).toBe("$1000.00 today (no cap) · $1000.00 this month (no cap)");
  });

  test("formatSpend shows spend vs caps", () => {
    const f = seed([{ at: Date.now() - 1000, usd: 5 }]);
    expect(formatSpend(f, { day: 20, month: 100 })).toBe("$5.00 of $20 today · $5.00 of $100 this month");
  });

  test("addSpend keeps 30 days of history", () => {
    const f = seed([{ at: Date.now() - 20 * DAY_MS, usd: 3 }, { at: Date.now() - 40 * DAY_MS, usd: 3 }]);
    addSpend(f, 1);
    expect(JSON.parse(require("node:fs").readFileSync(f, "utf8"))).toHaveLength(2);
  });
});

describe("spend caps config", () => {
  test("read from config.toml, absent means no cap", async () => {
    const home = tmp();
    expect(await loadSpendCaps({ XDG_CONFIG_HOME: home })).toEqual({});
    require("node:fs").mkdirSync(join(home, "bunker"));
    writeFileSync(join(home, "bunker", "config.toml"), 'max-cost-day = 5\nmax-cost-month = 80.5\n');
    expect(await loadSpendCaps({ XDG_CONFIG_HOME: home })).toEqual({ day: 5, month: 80.5 });
    writeFileSync(join(home, "bunker", "config.toml"), 'max-cost-day = "x"\n');
    await expect(loadSpendCaps({ XDG_CONFIG_HOME: home })).rejects.toThrow(/max-cost-day/);
  });
});
