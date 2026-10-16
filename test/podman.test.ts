import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { podman } from "../src/index.ts";

test("podman() runs `podman run` with --userns=keep-id instead of --user", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakepodman-"));
  await writeFile(join(dir, "podman"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\n`);
  await chmod(join(dir, "podman"), 0o755);

  const sandbox = podman({ image: "img", bin: join(dir, "podman") });
  await sandbox.exec(["agent", "--flag"], { worktree: dir, gitCommonDir: join(dir, ".git") });

  const args = (await readFile(join(dir, "args"), "utf8")).split("\n");
  expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
  expect(args).toContain("--userns=keep-id");
  expect(args).not.toContain("--user");
  expect(args).toContain(`${dir}:${dir}`);
  expect(args.slice(args.indexOf("--entrypoint"), args.indexOf("--entrypoint") + 4)).toEqual(["--entrypoint", "agent", "img", "--flag"]);
});
