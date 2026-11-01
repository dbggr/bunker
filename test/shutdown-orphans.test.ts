import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, podman } from "../src/index.ts";
import { agentStep } from "../src/pipeline/agent-step.ts";
import { Interrupted } from "../src/pipeline/errors.ts";
import { stopOrphanedContainers } from "../src/sandboxes/container.ts";
import type { Sandbox } from "../src/sandboxes/exec.ts";

setDefaultTimeout(60_000); // see test/setup.ts

describe("shutdown during a resume", () => {
  const run = async (signal: AbortSignal) => {
    const calls: string[][] = [];
    const store = await mkdtemp(join(tmpdir(), "bunker-store-"));
    await writeFile(join(store, "s1.jsonl"), "{}");
    const sandbox: Sandbox = { projectsDir: store, exec: async (cmd) => (calls.push(cmd), { code: 143, stdout: "" }) };
    const result = await agentStep({
      agent: claudeCode({ json: true }), sandbox, mode: "write", prompt: "p", prev: { id: "s1", file: join(store, "s1.jsonl") },
      ctx: { worktree: "/w", gitCommonDir: "/w/.git" }, target: {}, dest: "/tmp/x.jsonl", signal,
    }).then(() => undefined, (e) => e);
    return { calls, result };
  };

  test("a failed resume after the first signal starts no fresh session", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { calls, result } = await run(ctl.signal);
    expect(result).toBeInstanceOf(Interrupted);
    expect(calls).toHaveLength(1);
  });

  test("without a signal the fresh session still starts", async () => {
    const { calls } = await run(new AbortController().signal);
    expect(calls).toHaveLength(2);
  });
});

describe("container labels and orphans", () => {
  const fake = async (script: string) => {
    const dir = await mkdtemp(join(tmpdir(), "bunker-fakepodman-"));
    await writeFile(join(dir, "podman"), `#!/bin/sh\necho "$@" >> "${dir}/calls"\n${script}\n`);
    await chmod(join(dir, "podman"), 0o755);
    return { dir, bin: join(dir, "podman") };
  };

  test("agent containers are labelled with the watcher pid, repo and issue", async () => {
    const { dir, bin } = await fake("true");
    await podman({ image: "img", bin }).exec(["agent"], { worktree: "/r/.worktrees/58-slug", gitCommonDir: join(dir, ".git") });
    const run = (await readFile(join(dir, "calls"), "utf8")).split("\n").find((l) => l.startsWith("run "))!;
    expect(run).toContain(`--label bunker.pid=${process.pid}`);
    expect(run).toContain(`--label bunker.repo=${dir}`);
    expect(run).toContain("--label bunker.issue=58");
  });

  test("stops containers whose watcher pid is dead and leaves the others", async () => {
    const { dir, bin } = await fake(`[ "$1" = ps ] && printf 'dead-one\\t999999\\t58\\nlive-one\\t${process.pid}\\t59\\nno-pid\\t\\t\\n'`);
    const lines: string[] = [];
    await stopOrphanedContainers(bin, "/repo", (l) => lines.push(l), (pid) => pid === process.pid);
    const calls = (await readFile(join(dir, "calls"), "utf8")).split("\n");
    expect(calls).toContain("kill dead-one");
    expect(calls.some((l) => l.includes("live-one"))).toBe(false);
    expect(calls.some((l) => l.includes("no-pid"))).toBe(false);
    expect(lines).toEqual(["bunker: stopped orphaned container dead-one (#58)"]);
    expect(calls.find((l) => l.startsWith("ps"))).toContain("label=bunker.repo=/repo");
  });
});
