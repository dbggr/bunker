import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox } from "../src/index.ts";
import { runSetup } from "../src/worktree/admin.ts";
import { ConfigError } from "../src/core/config.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test("runSetup rejects with ConfigError when .bunker/config.toml is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-setupcfg-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await mkdir(join(dir, ".bunker"));
  await Bun.write(join(dir, ".bunker", "config.toml"), "this is = = not toml");
  await expect(runSetup(noSandbox(), { worktree: dir, gitCommonDir: join(dir, ".git") })).rejects.toBeInstanceOf(ConfigError);
});
