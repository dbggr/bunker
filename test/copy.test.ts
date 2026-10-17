import { afterEach, describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, review, run, runAll, type Agent } from "../src/index.ts";
import { redact } from "../src/redact.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-copy-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await Bun.write(join(dir, ".gitignore"), ".env\nfixtures/\nlocal.json\n");
  await Bun.write(join(dir, "tracked.txt"), "hi\n");
  await $`git -C ${dir} add . && git -C ${dir} commit -q -m init`;
  await Bun.write(join(dir, ".env"), "API_KEY=copied-secret-value-123\n# c\nPLAIN=\n");
  await mkdir(join(dir, "fixtures", "sub"), { recursive: true });
  await Bun.write(join(dir, "fixtures", "a.txt"), "A");
  await Bun.write(join(dir, "fixtures", "sub", "b.txt"), "B");
  await Bun.write(join(dir, "local.json"), "{}");
  return dir;
}

const sh = (script: string): Agent => ({ command: () => ["sh", "-c", script] });
const APPROVE = "<verdict>{\"approved\": true, \"required_changes\": []}</verdict>";

describe("copyToWorktree", () => {
  test(".bunker/copy: .env, glob and directory are copied, visible to the agent, never committed by git add -A", async () => {
    const repo = await makeRepo();
    await Bun.write(join(repo, ".bunker", "copy"), "# secrets\n.env\n\n*.json\nfixtures\nmissing.txt\n");
    const agent = sh('cat .env > seen.txt; cat fixtures/sub/b.txt >> seen.txt; ls local.json >> seen.txt; git add -A && git commit -qm x');
    const res = await run({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(res.commits).toHaveLength(1);
    const files = (await $`git -C ${repo} show --name-only --format= HEAD`.text()).trim().split("\n");
    expect(files).toEqual(["seen.txt"]);
    expect(await Bun.file(join(repo, "seen.txt")).text()).toContain("copied-secret-value-123");
    expect(await Bun.file(join(repo, "seen.txt")).text()).toContain("B");
  });

  test("library option overrides the file", async () => {
    const repo = await makeRepo();
    await Bun.write(join(repo, ".bunker", "copy"), ".env\n");
    const agent = sh("ls .env 2>/dev/null > out.txt; ls local.json >> out.txt; git add -A && git commit -qm x");
    await run({ cwd: repo, prompt: "p", agent, sandbox: noSandbox(), copyToWorktree: ["local.json"] });
    expect((await Bun.file(join(repo, "out.txt")).text()).trim()).toBe("local.json");
  });

  test("runAll copies into every worktree", async () => {
    const repo = await makeRepo();
    const agent = sh("cat .env > $$.seen; git add -A && git commit -qm x");
    const res = await runAll({ cwd: repo, tasks: [{ prompt: "a" }, { prompt: "b" }], agent, sandbox: noSandbox(), copyToWorktree: [".env"] });
    expect(res.map((r) => r.status)).toEqual(["merged", "merged"]);
  });

  test("runAll removes earlier worktrees and branches when a later copy fails", async () => {
    const repo = await makeRepo();
    const before = (await $`git -C ${repo} worktree list --porcelain`.text()).trim();
    let calls = 0;
    // A missing pattern warns once per copy; make the second copy throw.
    const warn = spyOn(console, "warn").mockImplementation(() => {
      if (++calls === 2) throw new Error("copy boom");
    });
    try {
      await expect(
        runAll({ cwd: repo, tasks: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }], agent: sh("true"), sandbox: noSandbox(), copyToWorktree: ["missing.txt"] }),
      ).rejects.toThrow("copy boom");
    } finally {
      warn.mockRestore();
    }
    expect((await $`git -C ${repo} worktree list --porcelain`.text()).trim()).toBe(before);
    expect((await $`git -C ${repo} branch --list ${"bunker/*"}`.text()).trim()).toBe("");
  });

  test("setup sees the copied file (review)", async () => {
    const repo = await makeRepo();
    const res = await review({
      cwd: repo, prompt: "p", sandbox: noSandbox(), setup: `cp .env setup-saw-env.txt; ! git status --porcelain | grep -q "?? .env"`,
      agent: { command: (_p, mode) => ["sh", "-c", mode === "review" ? `echo '${APPROVE}'` : "git add -A && git commit -qm x"] },
      copyToWorktree: [".env"],
    });
    expect(res.status).toBe("approved");
    expect(await Bun.file(join(repo, "setup-saw-env.txt")).exists()).toBe(true);
  });

  test("an agent that force-stages a copied file is rejected as failed, naming the file", async () => {
    const repo = await makeRepo();
    const res = await review({
      cwd: repo, prompt: "p", sandbox: noSandbox(), copyToWorktree: [".env"],
      agent: { command: (_p, mode) => ["sh", "-c", mode === "review" ? `echo '${APPROVE}'` : "git add -f .env && git commit -qm x"] },
    });
    expect(res.status).toBe("failed");
    expect(res.error).toContain(".env");
    expect(await Bun.file(join(repo, ".env")).text()).toContain("API_KEY");
    expect((await $`git -C ${repo} log --format=%s`.text()).trim()).toBe("init");
  });

  test("force-staging in run() throws", async () => {
    const repo = await makeRepo();
    const p = run({ cwd: repo, prompt: "p", sandbox: noSandbox(), copyToWorktree: [".env"], agent: sh("git add -f .env && git commit -qm x") });
    await expect(p).rejects.toThrow(".env");
  });

  test("paths outside the repo are rejected", async () => {
    const repo = await makeRepo();
    for (const bad of ["../x", "a/../../x", "/etc/passwd"]) {
      await expect(run({ cwd: repo, prompt: "p", sandbox: noSandbox(), agent: sh("true"), copyToWorktree: [bad] })).rejects.toThrow(/outside/);
    }
    await Bun.write(join(repo, ".bunker", "copy"), "../x\n");
    await expect(run({ cwd: repo, prompt: "p", sandbox: noSandbox(), agent: sh("true") })).rejects.toThrow(/outside/);
    const res = await review({ cwd: repo, prompt: "p", sandbox: noSandbox(), agent: sh("true"), copyToWorktree: ["../x"] });
    expect(res.status).toBe("failed");
  });

  test("symlinks inside a copied directory that point outside the repo are rejected", async () => {
    const repo = await makeRepo();
    const outside = await mkdtemp(join(tmpdir(), "bunker-outside-"));
    dirs.push(outside);
    await Bun.write(join(outside, "secret.txt"), "outside-secret");
    await mkdir(join(outside, "dir"));
    await Bun.write(join(outside, "dir", "x.txt"), "X");
    for (const target of [join(outside, "secret.txt"), join(outside, "dir")]) {
      await symlink(target, join(repo, "fixtures", "link"));
      await expect(run({ cwd: repo, prompt: "p", sandbox: noSandbox(), agent: sh("true"), copyToWorktree: ["fixtures"] })).rejects.toThrow(/outside/);
      await unlink(join(repo, "fixtures", "link"));
    }
  });

  test("values of copied .env files are redacted", async () => {
    const repo = await makeRepo();
    await run({ cwd: repo, prompt: "p", sandbox: noSandbox(), agent: sh("true"), copyToWorktree: [".env"] });
    expect(redact("token copied-secret-value-123 end")).toBe("token [REDACTED] end");
  });
});
