import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterrupt } from "../src/cli/commands/interrupt.ts";
import { abandonLive, track } from "../src/pipeline/issue-cleanup.ts";
import { waitForMerge } from "../src/github/branches.ts";
import type { BunkerEvent } from "../src/core/events.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const stage = (issue: number, name: string, at = 0): BunkerEvent => ({ type: "stage", issue, name, at });

function setup(extra: Partial<Parameters<typeof createInterrupt>[0]> = {}) {
  const lines: string[] = [];
  const codes: number[] = [];
  const requeued: number[] = [];
  let containers = 0;
  let t = 0;
  const ctl = new AbortController();
  const intr = createInterrupt({
    ctl, log: (l) => lines.push(l), exit: (c) => codes.push(c), now: () => t, progressMs: 0,
    requeue: async (n) => void requeued.push(n), stopContainers: () => void containers++, ...extra,
  });
  return { intr, ctl, lines, codes, requeued, containers: () => containers, at: (ms: number) => (t = ms) };
}

describe("first signal", () => {
  test("blocks new work, lists what is in flight and releases runs waiting on GitHub", () => {
    const s = setup();
    s.intr.onEvent(stage(477, "implement", 0));
    s.intr.onEvent(stage(12, "waiting for merge", 0));
    s.at(192_000);
    void s.intr.signal("SIGINT");
    expect(s.ctl.signal.aborted).toBe(true);
    expect(s.intr.stopping).toBe(true);
    const out = s.lines.join("\n");
    expect(out).toContain("#477 implement 3m 12s · finishing this step");
    expect(out).toContain("#12 waiting for merge · released");
    expect(out).toContain("Ctrl-C again stops now");
    expect(s.codes).toEqual([]);
  });

  test("shows the step timeout countdown", () => {
    const s = setup({ stepTimeoutMs: 600_000 });
    s.intr.onEvent(stage(5, "verify", 0));
    s.at(60_000);
    void s.intr.signal();
    expect(s.lines.join("\n")).toContain("step times out in 9m 0s");
  });

  test("announces a run that finishes while stopping", () => {
    const s = setup();
    s.intr.onEvent(stage(5, "implement"));
    void s.intr.signal();
    s.intr.onEvent(stage(5, "waiting for merge"));
    expect(s.lines.at(-1)).toContain("#5 waiting for merge; released to GitHub");
  });
});

describe("second signal", () => {
  test("stops containers, re-queues the interrupted issues and exits 130", async () => {
    const s = setup();
    s.intr.onEvent(stage(3, "merged"));
    s.intr.onEvent(stage(477, "implement"));
    s.intr.onEvent(stage(12, "waiting for merge"));
    void s.intr.signal();
    await s.intr.signal();
    expect(s.containers()).toBe(1);
    expect(s.requeued).toEqual([477]);
    expect(s.codes).toEqual([130]);
    const out = s.lines.join("\n");
    expect(out).toContain("merged: #3");
    expect(out).toContain("interrupted (re-queued): #477");
    expect(out).toContain("waiting on GitHub: #12");
  });

  test("exits within the deadline even if re-queueing hangs", async () => {
    const s = setup({ forceMs: 20, requeue: () => new Promise(() => {}) });
    s.intr.onEvent(stage(1, "implement"));
    void s.intr.signal();
    await s.intr.signal();
    expect(s.codes).toEqual([130]);
  });
});

describe("summary", () => {
  test("lists each category and spend, and the resume command", () => {
    const s = setup();
    s.intr.onEvent(stage(3, "merged"));
    s.intr.onEvent(stage(12, "awaiting review"));
    s.intr.onEvent({ type: "result", issue: 3, costUsd: 1.5, at: 0 });
    s.intr.onEvent({ type: "result", costUsd: 0.25, at: 0 });
    void s.intr.signal();
    s.lines.length = 0;
    s.intr.finish();
    expect(s.lines).toEqual([
      "bunker: stopped. Summary of this session:",
      "  merged: #3",
      "  interrupted (re-queued): none",
      "  waiting on GitHub: #12",
      "  spend: $1.75",
      "  resume with: bunker watch",
    ]);
  });

  test("prints nothing when no signal came", () => {
    const s = setup();
    s.intr.finish();
    expect(s.lines).toEqual([]);
  });
});

describe("waitForMerge", () => {
  test("a stop releases the wait", async () => {
    const ctl = new AbortController();
    const bin = await mkdtemp(join(tmpdir(), "bunker-gh-"));
    await Bun.write(join(bin, "gh"), "#!/bin/sh\necho '{\"state\":\"OPEN\"}'\n");
    await $`chmod +x ${join(bin, "gh")}`;
    const orig = process.env.PATH;
    process.env.PATH = `${bin}:${orig}`;
    try {
      setTimeout(() => ctl.abort(), 50);
      const started = Date.now();
      const r = await waitForMerge("https://example/pr/1", bin, { PATH: process.env.PATH! }, 60_000, 30_000, ctl.signal);
      expect(r.outcome).toBe("released");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      process.env.PATH = orig;
      await rm(bin, { recursive: true, force: true });
    }
  });
});

describe("abandonLive", () => {
  const dirs: string[] = [];
  afterEach(async () => void (await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))));

  test("keeps the work as a stale tag and removes the worktree and branch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "bunker-abandon-"));
    dirs.push(repo);
    await $`git init -q -b main ${repo} && git -C ${repo} config user.name T && git -C ${repo} config user.email t@e.x && git -C ${repo} commit -q --allow-empty -m init`;
    const base = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    const worktree = join(repo, ".worktrees", "9-x");
    await $`git -C ${repo} worktree add -q -b fix/9-x ${worktree}`;
    await Bun.write(join(worktree, "f.txt"), "wip");
    const untrack = track({ number: 9, repo, worktree, branch: "fix/9-x", base });
    const tag = await abandonLive(9);
    untrack();
    expect(tag).toMatch(/^bunker\/stale\/9-\d{8}T\d{6}Z$/);
    expect((await $`git -C ${repo} tag -l ${"bunker/stale/9-*"}`.text()).trim()).toBe(tag!);
    expect((await $`git -C ${repo} show ${tag!}:f.txt`.text())).toBe("wip");
    expect(existsSync(worktree)).toBe(false);
    expect((await $`git -C ${repo} branch --list fix/9-x`.text()).trim()).toBe("");
  });

  test("an empty run leaves no tag", async () => {
    const repo = await mkdtemp(join(tmpdir(), "bunker-abandon-"));
    dirs.push(repo);
    await $`git init -q -b main ${repo} && git -C ${repo} config user.name T && git -C ${repo} config user.email t@e.x && git -C ${repo} commit -q --allow-empty -m init`;
    const base = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    const worktree = join(repo, ".worktrees", "8-x");
    await $`git -C ${repo} worktree add -q -b fix/8-x ${worktree}`;
    track({ number: 8, repo, worktree, branch: "fix/8-x", base });
    expect(await abandonLive(8)).toBeUndefined();
    expect(existsSync(worktree)).toBe(false);
  });
});
