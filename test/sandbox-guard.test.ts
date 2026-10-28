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

async function runArgs(opts: Parameters<typeof podman>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakepodman-"));
  await writeFile(join(dir, "podman"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\n`);
  await chmod(join(dir, "podman"), 0o755);
  await podman({ image: "img", bin: join(dir, "podman"), ...opts }).exec(["agent"], { worktree: dir, gitCommonDir: join(dir, ".git") });
  return (await readFile(join(dir, "args"), "utf8")).split("\n");
}

test("containers drop capabilities, forbid new privileges and carry pids and memory limits", async () => {
  const args = await runArgs({});
  expect(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
  expect(args.slice(args.indexOf("--security-opt"), args.indexOf("--security-opt") + 2)).toEqual(["--security-opt", "no-new-privileges"]);
  expect(args[args.indexOf("--pids-limit") + 1]).toMatch(/^\d+$/);
  expect(args[args.indexOf("--memory") + 1]).toMatch(/^\d+[bkmg]$/);
});

test("the pids and memory limits can be overridden", async () => {
  const args = await runArgs({ limits: { pids: 99, memory: "2g" } });
  expect(args[args.indexOf("--pids-limit") + 1]).toBe("99");
  expect(args[args.indexOf("--memory") + 1]).toBe("2g");
});

test("containers never mount the real Claude credential files", async () => {
  const args = await runArgs({});
  const mounts = args.filter((a, i) => args[i - 1] === "-v");
  for (const m of mounts) {
    expect(m).not.toContain(".credentials.json");
    expect(m).not.toContain(".claude.json");
    expect(m.startsWith(`${process.env.HOME}/.claude`)).toBe(false);
  }
});
