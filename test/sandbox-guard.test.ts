import { expect, test, setDefaultTimeout } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, podman } from "../src/index.ts";
import { liveContainers } from "../src/sandboxes/container.ts";

setDefaultTimeout(60_000); // see test/setup.ts

test("containers are marked so the bunker CLI can refuse to run inside one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakepodman-"));
  await writeFile(join(dir, "podman"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\n`);
  await chmod(join(dir, "podman"), 0o755);
  await podman({ image: "img", bin: join(dir, "podman") }).exec(["agent"], { worktree: dir, gitCommonDir: join(dir, ".git") });
  const args = (await readFile(join(dir, "args"), "utf8")).split("\n");
  expect(args).toContain("BUNKER_IN_SANDBOX=1");
});

test("a finished container is no longer tracked for cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakepodman-"));
  await writeFile(join(dir, "podman"), `#!/bin/sh\ntrue\n`);
  await chmod(join(dir, "podman"), 0o755);
  await podman({ image: "img", bin: join(dir, "podman") }).exec(["agent"], { worktree: dir, gitCommonDir: join(dir, ".git") });
  expect(liveContainers.size).toBe(0);
});

test("the CLI refuses to run inside a bunker sandbox", async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "queue", "--no-sandbox"], {
    env: { ...process.env, BUNKER_IN_SANDBOX: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  expect(await p.exited).toBe(2);
  expect(err).toContain("inside a bunker sandbox");
});

test("--no-sandbox agents are marked too, so they can't run a nested bunker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-nosandbox-"));
  const r = await noSandbox().exec(["sh", "-c", 'echo "$BUNKER_IN_SANDBOX"'], { worktree: dir, gitCommonDir: join(dir, ".git") });
  expect(r.stdout.trim()).toBe("1");
});
