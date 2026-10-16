import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, noSandbox, review, run, runAll, runSetup, type Agent } from "../src/index.ts";

const dirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-timeout-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

const fakeAgent = (script: string): Agent => ({ command: () => ["sh", "-c", script] });
// A killed orphan may linger as a zombie when nothing reaps it; that is dead.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("idle timeout", () => {
  test("a silent agent is killed and the step fails as idle-timeout, branch kept", async () => {
    const repo = await makeRepo();
    const pidFile = join(repo, "..", `pid-${Date.now()}`);
    dirs.push(pidFile);
    const agent = fakeAgent(`echo $$ > ${pidFile}; exec sleep 30`);

    const r = await review({ cwd: repo, prompt: "x", agent, sandbox: noSandbox(), idleTimeoutMs: 300 });

    expect(r.status).toBe("idle-timeout");
    expect(r.error).toContain("printed nothing");
    expect((await $`git -C ${repo} branch --list ${r.branch}`.text()).trim()).not.toBe("");
    expect(alive(Number((await readFile(pidFile, "utf8")).trim()))).toBe(false);
  });

  test("the whole process group dies, not just the shell", async () => {
    const repo = await makeRepo();
    const pidFile = join(repo, "..", `cpid-${Date.now()}`);
    dirs.push(pidFile);
    const agent = fakeAgent(`sleep 30 & echo $! > ${pidFile}; wait`);

    const r = await review({ cwd: repo, prompt: "x", agent, sandbox: noSandbox(), idleTimeoutMs: 300 });

    expect(r.status).toBe("idle-timeout");
    await Bun.sleep(100);
    expect(alive(Number((await readFile(pidFile, "utf8")).trim()))).toBe(false);
  });

  test("output resets the timer: chatty for longer than the limit, then silent", async () => {
    const repo = await makeRepo();
    const started = Date.now();
    // 6 x 0.2s of chatter (1.2s) with a 0.6s limit, then silence.
    const agent = fakeAgent("for i in 1 2 3 4 5 6; do echo tick; sleep 0.2; done; exec sleep 30");

    const r = await review({ cwd: repo, prompt: "x", agent, sandbox: noSandbox(), idleTimeoutMs: 600 });

    expect(r.status).toBe("idle-timeout");
    expect(Date.now() - started).toBeGreaterThan(1500);
  });

  test("a chatty agent that finishes within the limit succeeds", async () => {
    const repo = await makeRepo();
    const agent = fakeAgent("for i in 1 2 3 4; do echo tick; sleep 0.2; done; echo a > a.txt && git add a.txt && git commit -qm a");

    const result = await run({ cwd: repo, prompt: "x", agent, sandbox: noSandbox(), idleTimeoutMs: 600 });

    expect(result.commits).toHaveLength(1);
  });

  test("run() throws and runAll() reports idle-timeout", async () => {
    const repo = await makeRepo();
    await expect(run({ cwd: repo, prompt: "x", agent: fakeAgent("exec sleep 30"), sandbox: noSandbox(), idleTimeoutMs: 200 })).rejects.toThrow("printed nothing");
    const [r] = await runAll({ cwd: repo, tasks: [{ prompt: "x" }], agent: fakeAgent("exec sleep 30"), sandbox: noSandbox(), idleTimeoutMs: 200 });
    expect(r?.status).toBe("idle-timeout");
  });

  test("a silent reviewer is killed too", async () => {
    const repo = await makeRepo();
    const agent = fakeAgent("echo a > a.txt && git add a.txt && git commit -qm a");
    const reviewer = fakeAgent("exec sleep 30");

    const r = await review({ cwd: repo, prompt: "x", agent, reviewer, sandbox: noSandbox(), idleTimeoutMs: 300 });

    expect(r.status).toBe("idle-timeout");
    expect(r.error).toContain("reviewer");
  });
});

describe("completion grace", () => {
  test("an agent that prints the approve signal then hangs counts as done", async () => {
    const repo = await makeRepo();
    const agent = fakeAgent("echo a > a.txt && git add a.txt && git commit -qm a");
    const reviewer = fakeAgent("echo '<review>APPROVE</review>'; exec sleep 30");
    const started = Date.now();

    const r = await review({ cwd: repo, prompt: "x", agent, reviewer, sandbox: noSandbox(), idleTimeoutMs: 20_000, completionTimeoutMs: 300 });

    expect(r.status).toBe("approved");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("the completion signal ends a run() loop after the grace window, with a warning", async () => {
    const repo = await makeRepo();
    const notes: string[] = [];
    const agent = fakeAgent("echo a > a.txt && git add a.txt && git commit -qm a; echo '<promise>COMPLETE</promise>'; exec sleep 30");

    const r = await run({
      cwd: repo, prompt: "x", agent, sandbox: noSandbox(), maxIterations: 3,
      idleTimeoutMs: 20_000, completionTimeoutMs: 300,
      onEvent: (e) => { if (e.type === "note") notes.push(e.text ?? ""); },
    });

    expect(r.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(r.iterations).toHaveLength(1);
    expect(notes.join("\n")).toContain("warning");
  });

  test("a stream agent's final result event starts the grace window", async () => {
    const repo = await makeRepo();
    const agent: Agent = {
      command: () => ["sh", "-c", `echo a > a.txt && git add a.txt && git commit -qm a; echo '{"type":"result"}'; exec sleep 30`],
      parseLine: (line) => (line.includes('"result"') ? [{ type: "result", text: "" }] : []),
    };

    const r = await run({ cwd: repo, prompt: "x", agent, sandbox: noSandbox(), idleTimeoutMs: 20_000, completionTimeoutMs: 300 });

    expect(r.commits).toHaveLength(1);
  });

  test("an agent that exits by itself is not touched", async () => {
    const repo = await makeRepo();
    const r = await run({ cwd: repo, prompt: "x", agent: fakeAgent("echo '<promise>COMPLETE</promise>'"), sandbox: noSandbox(), completionTimeoutMs: 300 });
    expect(r.completionSignal).toBeDefined();
  });
});

describe("setup and verify use --step-timeout", () => {
  test("slow setup within the step timeout succeeds even past the idle timeout", async () => {
    const repo = await makeRepo();
    const out = await runSetup(noSandbox(), { worktree: repo, gitCommonDir: join(repo, ".git") }, "sleep 0.6; echo ready", { idleTimeoutMs: 200, stepTimeoutMs: 5000 });
    expect(out?.code).toBe(0);
    expect(out?.stdout).toContain("ready");
  });

  test("silent setup beyond the step timeout is killed", async () => {
    const repo = await makeRepo();
    const out = await runSetup(noSandbox(), { worktree: repo, gitCommonDir: join(repo, ".git") }, "sleep 30", { stepTimeoutMs: 300 });
    expect(out?.idleTimedOut).toBe(true);
  });

  test("review() fails as idle-timeout when setup hangs", async () => {
    const repo = await makeRepo();
    const r = await review({ cwd: repo, prompt: "x", agent: fakeAgent("true"), sandbox: noSandbox(), setup: "sleep 30", stepTimeoutMs: 300 });
    expect(r.status).toBe("idle-timeout");
    expect(r.error).toContain("setup");
  });
});

describe("docker", () => {
  test("a killed step stops its container, not just the client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bunker-fakedocker-"));
    dirs.push(dir);
    const bin = join(dir, "docker");
    // `run` hangs like a client attached to a container; `kill` is logged.
    await writeFile(bin, `#!/bin/sh\nif [ "$1" = run ]; then echo "$@" > "${dir}/run"; exec sleep 30; fi\necho "$@" >> "${dir}/calls"\n`);
    await chmod(bin, 0o755);
    const repo = await makeRepo();

    const res = await docker({ image: "img", bin }).exec(["true"], { worktree: repo, gitCommonDir: join(repo, ".git"), idleMs: 300 });

    expect(res.idleTimedOut).toBe(true);
    const name = /--name (\S+)/.exec(await readFile(join(dir, "run"), "utf8"))?.[1];
    expect(name).toBeTruthy();
    await Bun.sleep(100);
    expect(existsSync(join(dir, "calls"))).toBe(true);
    expect(await readFile(join(dir, "calls"), "utf8")).toContain(`kill ${name}`);
  });
});
