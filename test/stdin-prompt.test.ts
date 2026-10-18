import { expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, docker, noSandbox, review } from "../src/index.ts";
import type { Agent } from "../src/index.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const BIG = "x".repeat(300_000) + "\nend-of-prompt";

test("claudeCode() keeps the prompt out of argv and offers it as input", () => {
  const a = claudeCode();
  const cmd = a.command(BIG, "write");
  expect(cmd.join("\n")).not.toContain("xxxx");
  expect(cmd.slice(0, 2)).toEqual(["claude", "-p"]);
  expect(a.input?.("hi", "write")).toContain("hi");
  expect(a.input?.("hi", "write")).toContain("commit your changes");
  expect(a.input?.("hi", "review")).toBe("hi");
});

test("noSandbox delivers a 300 KB stdin intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-stdin-"));
  await $`git init -q ${dir}`;
  const out = join(dir, "got");
  const r = await noSandbox().exec(["sh", "-c", `cat > ${out}; echo done`], { worktree: dir, gitCommonDir: join(dir, ".git"), stdin: BIG });
  expect(r.code).toBe(0);
  expect(await readFile(out, "utf8")).toBe(BIG);
});

test("docker passes -i and delivers a 300 KB stdin intact, none of it in argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-stdin-"));
  await $`git init -q ${dir}`;
  await writeFile(join(dir, "docker"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\ncat > "${dir}/stdin"\n`);
  await chmod(join(dir, "docker"), 0o755);
  const sandbox = docker({ image: "img", bin: join(dir, "docker") });
  await sandbox.exec(["agent"], { worktree: dir, gitCommonDir: join(dir, ".git"), stdin: BIG });
  const args = (await readFile(join(dir, "args"), "utf8")).split("\n");
  expect(args).toContain("-i");
  expect(args.join("\n")).not.toContain("xxxx");
  expect(await readFile(join(dir, "stdin"), "utf8")).toBe(BIG);
});

test("a large diff gives the reviewer a bounded prompt pointing at git diff", async () => {
  const repo = await mkdtemp(join(tmpdir(), "bunker-bigdiff-"));
  await $`git init -q -b main ${repo} && git -C ${repo} config user.email a@b.c && git -C ${repo} config user.name n && git -C ${repo} commit -q --allow-empty -m init`;
  const seen: { prompt: string; mode: string }[] = [];
  const agent: Agent = {
    command(prompt, mode = "write") {
      seen.push({ prompt, mode });
      if (mode === "review") return ["sh", "-c", `echo '<verdict>{"approved": true, "required_changes": []}</verdict>'`];
      return ["sh", "-c", `head -c 200000 /dev/zero | tr '\\0' 'a' > big.txt; git add . && git commit -qm big`];
    },
  };
  const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
  expect(r.status).toBe("approved");
  const rev = seen.find((s) => s.mode === "review")!;
  expect(rev.prompt.length).toBeLessThan(70_000);
  expect(rev.prompt).toContain("big.txt");
  expect(rev.prompt).toMatch(/git diff \S+\.\.HEAD/);
});
