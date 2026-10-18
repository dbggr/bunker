import { expect, setDefaultTimeout, test } from "bun:test";
import { Glob } from "bun";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBunkerEnv } from "../src/core/env.ts";
import { ISSUE_PROMPT } from "../src/pipeline/issue-prompt.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const real = process.env.BUNKER_TEST_REAL_DOCKER === "1";

test.skipIf(real)("docker, podman, the desktop notifiers and network tools resolve to the preload's fakes, not real binaries", () => {
  const fakes = process.env.BUNKER_TEST_FAKE_BIN!;
  expect(fakes).toBeTruthy();
  for (const bin of ["docker", "podman", "notify-send", "osascript", "curl", "wget"]) {
    expect(Bun.which(bin, { PATH: process.env.PATH! })).toBe(join(fakes, bin));
  }
});

test.skipIf(real)("the fake docker refuses mutating commands", async () => {
  for (const args of [["rmi", "x"], ["rm", "x"], ["system", "prune"], ["run", "x"]]) {
    const r = Bun.spawnSync(["docker", ...args]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("tests must not reach");
  }
});

test("tests that use the real docker daemon opt in with the marker and only touch bunker-test- images", async () => {
  const offenders: string[] = [];
  for await (const file of new Glob("*.test.ts").scan(import.meta.dir)) {
    if (file === "hygiene.test.ts") continue;
    const text = await Bun.file(join(import.meta.dir, file)).text();
    if (/\$`docker info`/.test(text) && !(/describe\.skipIf\(!dockerUp\)/.test(text) && /BUNKER_TEST_REAL_DOCKER/.test(text) && /bunker-test-/.test(text))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("the implementer prompt puts .github/workflows/ off-limits", () => {
  expect(ISSUE_PROMPT).toContain(".github/workflows/");
  expect(ISSUE_PROMPT).toMatch(/off-limits/);
});

test("no gh pr edit in src: it queries Projects (classic) and fails; labels and reviewers go through REST", async () => {
  const offenders: string[] = [];
  for await (const file of new Glob("**/*.ts").scan(join(import.meta.dir, "..", "src"))) {
    if (/gh pr edit|"pr", "edit"/.test(await Bun.file(join(import.meta.dir, "..", "src", file)).text())) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("tests cannot read the real user config: XDG_CONFIG_HOME is an empty temp dir", async () => {
  const dir = process.env.XDG_CONFIG_HOME!;
  expect(dir).toBeTruthy();
  expect(dir.startsWith(tmpdir())).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
});

test("with BUNKER_APP_ID in the real ~/.config/bunker/.env, loading the env in a test does not see it", async () => {
  const home = mkdtempSync(join(tmpdir(), "bunker-test-realhome-"));
  try {
    mkdirSync(join(home, ".config", "bunker"), { recursive: true });
    writeFileSync(join(home, ".config", "bunker", ".env"), "BUNKER_APP_ID=123\n");
    // A developer's HOME with the opt-in, seen through the test process's own XDG_CONFIG_HOME.
    const env: Record<string, string | undefined> = { HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    await loadBunkerEnv(home, env);
    expect(env.BUNKER_APP_ID).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
