import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, runAll, run, type Agent } from "../src/index.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-iter-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

// The prompt is a shell script. $N is the iteration number (1-based), derived from
// the commits already in the worktree, so state carries across iterations.
const shellAgent: Agent = { command: (prompt) => ["sh", "-c", `N=$(( $(git rev-list --count HEAD) )); ${prompt}`] };

// Commits one file per iteration and prints `signal` from iteration `at` onwards.
const worker = (signal: string, at: number) =>
  `echo $N > f$N.txt && git add . && git commit -qm "iter $N"; [ $N -ge ${at} ] && echo '${signal}'; true`;

async function branches(repo: string): Promise<string[]> {
  return (await $`git -C ${repo} branch ${"--format=%(refname:short)"}`.text()).trim().split("\n");
}

describe("run() iterations", () => {
  test("defaults to a single iteration", async () => {
    const repo = await makeRepo();
    const result = await run({ cwd: repo, prompt: worker("<promise>COMPLETE</promise>", 99), agent: shellAgent, sandbox: noSandbox() });
    expect(result.iterations).toHaveLength(1);
    expect(result.completionSignal).toBeUndefined();
  });

  test("stops early after an iteration whose stdout has the signal", async () => {
    const repo = await makeRepo();
    const result = await run({
      cwd: repo,
      prompt: worker("<promise>COMPLETE</promise>", 2),
      agent: shellAgent,
      sandbox: noSandbox(),
      maxIterations: 5,
    });
    expect(result.iterations).toHaveLength(2);
    expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  test("runs to maxIterations without a signal", async () => {
    const repo = await makeRepo();
    const result = await run({ cwd: repo, prompt: worker("nope", 99), agent: shellAgent, sandbox: noSandbox(), maxIterations: 3 });
    expect(result.iterations).toHaveLength(3);
    expect(result.completionSignal).toBeUndefined();
  });

  test("accepts a custom signal or an array of signals", async () => {
    const repo = await makeRepo();
    const one = await run({ cwd: repo, prompt: worker("ALL DONE", 1), agent: shellAgent, sandbox: noSandbox(), maxIterations: 4, completionSignal: "ALL DONE" });
    expect(one.iterations).toHaveLength(1);
    expect(one.completionSignal).toBe("ALL DONE");

    const many = await run({ cwd: repo, prompt: worker("STOP", 1), agent: shellAgent, sandbox: noSandbox(), maxIterations: 4, completionSignal: ["ALL DONE", "STOP"] });
    expect(many.iterations).toHaveLength(1);
    expect(many.completionSignal).toBe("STOP");
  });

  test("the default signal is ignored when a custom one is given", async () => {
    const repo = await makeRepo();
    const result = await run({ cwd: repo, prompt: worker("<promise>COMPLETE</promise>", 1), agent: shellAgent, sandbox: noSandbox(), maxIterations: 2, completionSignal: "X" });
    expect(result.iterations).toHaveLength(2);
  });

  test("commits accumulate across iterations, per iteration and in total", async () => {
    const repo = await makeRepo();
    const result = await run({ cwd: repo, prompt: worker("<promise>COMPLETE</promise>", 3), agent: shellAgent, sandbox: noSandbox(), maxIterations: 5 });
    expect(result.iterations.map((i) => i.commits.map((c) => c.subject))).toEqual([["iter 1"], ["iter 2"], ["iter 3"]]);
    expect(result.iterations.map((i) => i.exitCode)).toEqual([0, 0, 0]);
    expect(result.commits.map((c) => c.subject)).toEqual(["iter 1", "iter 2", "iter 3"]);
    expect(await Bun.file(join(repo, "f3.txt")).exists()).toBe(true);
    expect(await branches(repo)).toEqual(["main"]);
  });

  test("a failure mid-loop throws and keeps the branch", async () => {
    const repo = await makeRepo();
    const prompt = `echo $N > f$N.txt && git add . && git commit -qm "iter $N"; [ $N -lt 3 ] || exit 4`;
    await expect(run({ cwd: repo, prompt, agent: shellAgent, sandbox: noSandbox(), maxIterations: 5 })).rejects.toThrow(/exited with 4/);
    const kept = (await branches(repo)).filter((b) => b.startsWith("bunker/"));
    expect(kept).toHaveLength(1);
    expect((await $`git -C ${repo} log --format=%s ${kept[0]!}`.text()).split("\n")).toContain("iter 3");
  });

  test("the engine does not inject the signal into the prompt", async () => {
    const repo = await makeRepo();
    const seen: string[] = [];
    const agent: Agent = { command: (p) => (seen.push(p), ["true"]) };
    await run({ cwd: repo, prompt: "hello", agent, sandbox: noSandbox() });
    expect(seen).toEqual(["hello"]);
  });
});

describe("runAll() iterations", () => {
  test("each task iterates on its own and reports its own iterations", async () => {
    const repo = await makeRepo();
    const results = await runAll({
      cwd: repo,
      agent: { command: (p) => ["sh", "-c", p] },
      sandbox: noSandbox(),
      maxIterations: 3,
      tasks: [
        { prompt: `[ -f a1 ] && echo '<promise>COMPLETE</promise>'; touch a1 && echo a >> a.txt && git add a.txt && git commit -qm a` },
        { prompt: `echo b >> b.txt && git add b.txt && git commit -qm b` },
      ],
    });
    expect(results.map((r) => r.status)).toEqual(["merged", "merged"]);
    expect(results.map((r) => r.iterations.length)).toEqual([2, 3]);
    expect(results[0]!.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(results[1]!.completionSignal).toBeUndefined();
    expect(results[1]!.commits).toHaveLength(3);
  });
});
