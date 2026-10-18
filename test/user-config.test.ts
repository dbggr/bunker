import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deprecatedUserKeys, readUserConfig, userConfigPath } from "../src/core/user-config.ts";

setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunker-uc-"));
  dirs.push(d);
  return d;
};

test("path honours XDG_CONFIG_HOME, then HOME/.config", () => {
  expect(userConfigPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/bunker/config.toml");
  expect(userConfigPath({ HOME: "/h" })).toBe("/h/.config/bunker/config.toml");
});

test("a missing file is an empty config; a present one is parsed", async () => {
  const home = tmp();
  expect(await readUserConfig({ XDG_CONFIG_HOME: home })).toEqual({});
  mkdirSync(join(home, "bunker"));
  writeFileSync(join(home, "bunker", "config.toml"), 'a = 1\nb = ["x"]\n');
  expect(await readUserConfig({ XDG_CONFIG_HOME: home })).toEqual({ a: 1, b: ["x"] });
});

test("kebab-case keys are still read, renamed to snake_case, with a deprecation warning naming the new key", async () => {
  const home = tmp();
  mkdirSync(join(home, "bunker"));
  writeFileSync(join(home, "bunker", "config.toml"), 'max-cost-day = 5\nallow-labelers = ["a"]\n');
  const warnings: string[] = [];
  expect(await readUserConfig({ XDG_CONFIG_HOME: home }, (w) => warnings.push(w))).toEqual({ max_cost_day: 5, allow_labelers: ["a"] });
  expect(warnings.length).toBe(2);
  expect(warnings[0]).toContain("max-cost-day");
  expect(warnings[0]).toContain("max_cost_day");
  expect(deprecatedUserKeys({ "max-cost-month": 1, max_cost_day: 2 })).toEqual([{ old: "max-cost-month", new: "max_cost_month" }]);
});

test("snake_case keys read silently and win over a kebab-case duplicate", async () => {
  const home = tmp();
  mkdirSync(join(home, "bunker"));
  writeFileSync(join(home, "bunker", "config.toml"), 'max_cost_day = 7\nmax-cost-day = 5\n');
  const warnings: string[] = [];
  expect(await readUserConfig({ XDG_CONFIG_HOME: home }, (w) => warnings.push(w))).toEqual({ max_cost_day: 7 });
  writeFileSync(join(home, "bunker", "config.toml"), 'max_cost_day = 7\n');
  warnings.length = 0;
  await readUserConfig({ XDG_CONFIG_HOME: home }, (w) => warnings.push(w));
  expect(warnings).toEqual([]);
});
