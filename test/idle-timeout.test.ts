import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, review, run, runSetup, type Agent } from "../src/index.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-idle-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const script = (sh: string): Agent => ({ command: () => ["sh", "-c", sh] });

describe("idle timeout", () => {
  test("silent agent → idle-timeout, process gone, branch kept", async () => {
    const repo = await makeRepo();
    const pidFile = join(repo, "..", `pid-${crypto.randomUUID()}`);
    const r = await review({ cwd: repo, prompt: "x", agent: script(`echo $$ > ${pidFile}; sleep 30`), sandbox: noSandbox(), idleTimeoutMs: 400 });
    expect(r.status).toBe("idle-timeout");
    expect(r.error).toMatch(/idle/i);
    const pid = Number((await Bun.file(pidFile).text()).trim());
    await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
    const branches = (await $`git -C ${repo} branch ${"--format=%(refname:short)"}`.text()).trim().split("\n");
    expect(branches).toContain(r.branch);
    await rm(pidFile, { force: true });
  });

  test("run() throws on a silent agent", async () => {
    const repo = await makeRepo();
    await expect(run({ cwd: repo, prompt: "x", agent: script("sleep 30"), sandbox: noSandbox(), idleTimeoutMs: 300 })).rejects.toThrow(/idle/i);
  });

  test("chatty then silent: each output resets the timer", async () => {
    const repo = await makeRepo();
    const t0 = Date.now();
    const r = await review({
      cwd: repo, prompt: "x", sandbox: noSandbox(), idleTimeoutMs: 700,
      agent: script("for i in 1 2 3 4; do echo tick; sleep 0.4; done; sleep 30"),
    });
    expect(r.status).toBe("idle-timeout");
    // Chatty phase lasts ~1.6s, longer than the limit; the kill comes ~0.7s after the last tick.
    expect(Date.now() - t0).toBeGreaterThan(1900);
  });

  test("chatty agent that finishes within the limit is fine", async () => {
    const repo = await makeRepo();
    const r = await review({
      cwd: repo, prompt: "x", sandbox: noSandbox(), idleTimeoutMs: 700, maxRounds: 1,
      agent: { command: (_p, mode) => ["sh", "-c", mode === "review" ? "echo '<review>APPROVE</review>'" : "for i in 1 2 3; do echo tick; sleep 0.4; done"] },
    });
    expect(r.status).toBe("approved");
  });
});

describe("completion grace", () => {
  test("reviewer prints approve then hangs → approved after the grace window", async () => {
    const repo = await makeRepo();
    const t0 = Date.now();
    const r = await review({
      cwd: repo, prompt: "x", sandbox: noSandbox(), completionTimeoutMs: 500, idleTimeoutMs: 20_000, maxRounds: 1,
      agent: { command: (_p, mode) => ["sh", "-c", mode === "review" ? "echo '<review>APPROVE</review>'; sleep 30" : "true"] },
    });
    expect(r.status).toBe("approved");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test("run(): completion signal then hang → completed", async () => {
    const repo = await makeRepo();
    const res = await run({ cwd: repo, prompt: "x", sandbox: noSandbox(), completionTimeoutMs: 400, idleTimeoutMs: 20_000, agent: script("echo '<promise>COMPLETE</promise>'; sleep 30") });
    expect(res.completionSignal).toBe("<promise>COMPLETE</promise>");
  });

  test("stream result event then hang → completed, warning noted", async () => {
    const repo = await makeRepo();
    const notes: string[] = [];
    const agent: Agent = {
      command: () => ["sh", "-c", `echo '{"type":"result","result":"ok","total_cost_usd":0,"duration_ms":1}'; sleep 30`],
      parseLine: () => [],
    };
    const res = await run({ cwd: repo, prompt: "x", agent, sandbox: noSandbox(), completionTimeoutMs: 400, idleTimeoutMs: 20_000, onEvent: (e) => { if (e.type === "note") notes.push(e.text ?? ""); } });
    expect(res.iterations[0]!.exitCode).toBe(0);
    expect(notes.join("\n")).toMatch(/grace|did not exit/i);
  });
});

describe("step timeout (setup/verify)", () => {
  test("quiet setup within --step-timeout succeeds (idle limit not applied)", async () => {
    const repo = await makeRepo();
    const out = await runSetup(noSandbox(), { worktree: repo, gitCommonDir: join(repo, ".git") }, "sleep 0.8", { stepTimeoutMs: 5000 });
    expect(out?.code).toBe(0);
    expect(out?.timedOut).toBeUndefined();
  });

  test("setup over the step timeout is killed", async () => {
    const repo = await makeRepo();
    const out = await runSetup(noSandbox(), { worktree: repo, gitCommonDir: join(repo, ".git") }, "sleep 30", { stepTimeoutMs: 300 });
    expect(out?.timedOut).toBe("step");
    expect(out?.code).not.toBe(0);
  });
});
