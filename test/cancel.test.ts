import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelRequested, issueScope, markCancelled, requestCancel, takeCancelRequests, takeCancelled } from "../src/core/cancel.ts";
import { createCanceller, activeIssues } from "../src/cli/commands/cancel.ts";
import { agentStep } from "../src/pipeline/agent-step.ts";
import { Interrupted } from "../src/pipeline/errors.ts";
import type { Agent } from "../src/agents/agent.ts";
import type { Sandbox } from "../src/sandboxes/exec.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "bunker-cancel-"));
  dirs.push(d);
  return d;
};

describe("cancel requests", () => {
  test("are taken once, per issue", async () => {
    const repo = await tmp();
    expect(takeCancelRequests(repo)).toEqual([]);
    requestCancel(repo, 3);
    requestCancel(repo, 9);
    expect(takeCancelRequests(repo).sort()).toEqual([3, 9]);
    expect(takeCancelRequests(repo)).toEqual([]);
  });
  test("only the cancelled issue's scope sees it", async () => {
    markCancelled(41);
    expect(await issueScope.run(41, async () => cancelRequested())).toBe(true);
    expect(await issueScope.run(42, async () => cancelRequested())).toBe(false);
    expect(cancelRequested()).toBe(false);
    expect(takeCancelled(41)).toBe(true);
    expect(takeCancelled(41)).toBe(false);
  });
});

describe("activeIssues", () => {
  test("skips runs that only wait on GitHub", () => {
    expect(activeIssues([{ issue: 1, stage: "implement" }, { issue: 2, stage: "waiting for merge" }, { issue: 3, stage: "awaiting review" }])).toEqual([1]);
  });
});

function canceller(active: number[]) {
  const events: string[] = [];
  const cancel = createCanceller({
    active: () => active,
    mark: (n) => void events.push(`mark ${n}`),
    stopContainers: (n) => void events.push(`stop ${n}`),
    abandon: async (n) => (events.push(`abandon ${n}`), "bunker/stale/1-x"),
    unlabel: async (n) => void events.push(`unlabel ${n}`),
    comment: async (n, body) => void events.push(`comment ${n}: ${body}`),
    log: (l) => void events.push(`log ${l}`),
  });
  return { cancel, events };
}

describe("createCanceller", () => {
  test("cancels one active run only: stops it, keeps its work, relabels and comments", async () => {
    const { cancel, events } = canceller([5, 6]);
    expect(await cancel(5)).toBe(true);
    expect(events.slice(0, 4)).toEqual(["mark 5", "stop 5", "abandon 5", "unlabel 5"]);
    expect(events[4]).toMatch(/^comment 5: .*cancelled.*bunker\/stale\/1-x/);
    expect(events.some((e) => / 6\b/.test(e) && !e.startsWith("log"))).toBe(false);
  });
  test("ignores an issue without an active run", async () => {
    const { cancel, events } = canceller([5]);
    expect(await cancel(6)).toBe(false);
    expect(events.every((e) => e.startsWith("log"))).toBe(true);
  });
});

// A cancelled run must start no agent session, whether it is the implementer or a reviewer retry.
describe("agentStep in a cancelled run", () => {
  const agent: Agent = { command: () => ["true"] };
  for (const role of ["implementer", "reviewer"] as const) {
    test(`${role}: no container is started`, async () => {
      let execs = 0;
      const sandbox: Sandbox = { exec: async () => (execs++, { code: 0, stdout: "", timedOut: undefined } as any) };
      const run = () => agentStep({ agent, sandbox, mode: role === "implementer" ? "write" : "review", prompt: "p", target: { role }, ctx: { worktree: "/w", gitCommonDir: "/g" }, dest: "/dev/null" } as any);
      markCancelled(77);
      await expect(issueScope.run(77, run)).rejects.toBeInstanceOf(Interrupted);
      expect(execs).toBe(0);
      takeCancelled(77);
      await issueScope.run(77, run);
      expect(execs).toBe(1);
    });
  }
});
