import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, runAll, type Agent } from "../src/index.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-all-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await tempDir();
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await Bun.write(join(dir, "shared.txt"), "original\n");
  await $`git -C ${dir} add shared.txt`;
  await $`git -C ${dir} commit -q -m init`;
  return dir;
}

// Each task's prompt is the shell script the fake agent runs.
const shellAgent: Agent = { command: (prompt) => ["sh", "-c", prompt] };

const commitFile = (name: string) => `echo ${name} > ${name}.txt && git add ${name}.txt && git commit -qm 'add ${name}'`;

async function branches(repo: string): Promise<string[]> {
  return (await $`git -C ${repo} branch ${"--format=%(refname:short)"}`.text()).trim().split("\n");
}

describe("runAll()", () => {
  test("merges every task's commits, in task order, and cleans up", async () => {
    const repo = await makeRepo();

    const results = await runAll({
      cwd: repo,
      agent: shellAgent,
      sandbox: noSandbox(),
      tasks: [{ prompt: commitFile("a") }, { prompt: commitFile("b") }],
    });

    expect(results.map((r) => r.status)).toEqual(["merged", "merged"]);
    expect(results.map((r) => r.commits.map((c) => c.subject))).toEqual([["add a"], ["add b"]]);
    expect(await Bun.file(join(repo, "a.txt")).exists()).toBe(true);
    expect(await Bun.file(join(repo, "b.txt")).exists()).toBe(true);
    expect(await branches(repo)).toEqual(["main"]);
    expect((await $`git -C ${repo} worktree list`.text()).trim().split("\n")).toHaveLength(1);
  });

  test("agents run concurrently", async () => {
    const repo = await makeRepo();
    const barrier = await tempDir();
    // Each agent checks in, then waits for the other. Run one at a time, the first would time out.
    const meetThen = (name: string) =>
      `touch ${barrier}/${name}; i=0; while [ $(ls ${barrier} | wc -l) -lt 2 ]; do ` +
      `i=$((i+1)); [ $i -gt 100 ] && exit 9; sleep 0.05; done; ${commitFile(name)}`;

    const results = await runAll({
      cwd: repo,
      agent: shellAgent,
      sandbox: noSandbox(),
      tasks: [{ prompt: meetThen("a") }, { prompt: meetThen("b") }],
    });

    expect(results.map((r) => r.status)).toEqual(["merged", "merged"]);
  }, 20_000);

  test("a conflicting task is reported, its branch kept, and the repo left clean", async () => {
    const repo = await makeRepo();
    const edit = (text: string) => `echo ${text} > shared.txt && git commit -qam '${text}'`;

    const results = await runAll({
      cwd: repo,
      agent: shellAgent,
      sandbox: noSandbox(),
      tasks: [{ prompt: edit("first") }, { prompt: edit("second") }, { prompt: commitFile("c") }],
    });

    expect(results.map((r) => r.status)).toEqual(["merged", "conflict", "merged"]);
    expect(await Bun.file(join(repo, "shared.txt")).text()).toBe("first\n");
    expect(await Bun.file(join(repo, "c.txt")).exists()).toBe(true);
    expect((await $`git -C ${repo} status --porcelain`.text()).trim()).toBe("");
    expect(await branches(repo)).toEqual([results[1]!.branch, "main"]);
    expect(results[1]!.error).toMatch(/conflict/i);
  });

  test("a failing agent doesn't stop the others", async () => {
    const repo = await makeRepo();

    const results = await runAll({
      cwd: repo,
      agent: shellAgent,
      sandbox: noSandbox(),
      tasks: [{ prompt: "exit 4" }, { prompt: commitFile("b") }],
    });

    expect(results.map((r) => r.status)).toEqual(["failed", "merged"]);
    expect(results[0]!.error).toMatch(/exited with 4/);
    expect(await Bun.file(join(repo, "b.txt")).exists()).toBe(true);
    expect(await branches(repo)).toEqual([results[0]!.branch, "main"]);
  });

  test("a task that commits nothing is merged with no commits and its branch removed", async () => {
    const repo = await makeRepo();

    const results = await runAll({ cwd: repo, agent: shellAgent, sandbox: noSandbox(), tasks: [{ prompt: "true" }] });

    expect(results[0]).toMatchObject({ status: "merged", commits: [] });
    expect(await branches(repo)).toEqual(["main"]);
  });
});

describe("runAll() live output", () => {
  test("prefixes each line with the task index; results stay unprefixed", async () => {
    const repo = await makeRepo();
    const written: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runAll({
        cwd: repo,
        agent: shellAgent,
        sandbox: noSandbox(),
        tasks: [{ prompt: "echo one; echo two" }, { prompt: "printf tail" }],
      });
    } finally {
      process.stdout.write = orig;
    }
    const lines = written.join("").split("\n").filter(Boolean).sort();
    expect(lines).toEqual(["[0] one", "[0] two", "[1] tail"]);
  });
});
