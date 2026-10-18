import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** process.env without any GIT_CONFIG_* overrides (another test file may have hardened this process), maintenance off. */
function plainEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_CONFIG_")) env[k] = v;
  return { ...env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0" };
}

/** A repo with a bare origin, two leftover `bunker/<id>` branches, and a reference-transaction hook that leaves a marker. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bunker-harden-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const marker = join(root, "hook-ran");
  const env = plainEnv();
  await $`git init -q --bare -b main ${origin}`.env(env);
  await $`git init -q -b main ${repo}`.env(env);
  await $`git -C ${repo} config user.name Test`.env(env);
  await $`git -C ${repo} config user.email test@example.com`.env(env);
  await $`git -C ${repo} commit -q --allow-empty -m init`.env(env);
  await $`git -C ${repo} remote add origin ${origin}`.env(env);
  await $`git -C ${repo} push -q -u origin main`.env(env);
  await $`git -C ${repo} branch bunker/cafebabe`.env(env);
  await $`git -C ${repo} branch bunker/deadbeef`.env(env);
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  await Bun.write(hook, `#!/bin/sh\necho ran >> "${marker}"\n`);
  await chmod(hook, 0o755);
  return { repo, marker, env };
}

test("the CLI runs host git with repo hooks disabled (hardenHostGit)", async () => {
  const { repo, marker, env } = await setup();

  // Control: the same kind of git op, without bunker's overrides, does fire the hook.
  await $`git -C ${repo} branch -D bunker/cafebabe`.env(env).quiet();
  expect(existsSync(marker)).toBe(true);
  await rm(marker);

  // `bunker clean --yes` deletes the leftover run branch with host git; the hook must not run.
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "clean", "--yes"], { cwd: repo, env });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain("delete branch bunker/deadbeef");
  expect((await $`git -C ${repo} for-each-ref ${"--format=%(refname:short)"} refs/heads`.env(env).text()).trim().split("\n")).toEqual(["main"]);
  expect(existsSync(marker)).toBe(false);
});
