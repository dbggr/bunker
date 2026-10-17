import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUserConfig, userConfigPath } from "../src/user-config.ts";

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
