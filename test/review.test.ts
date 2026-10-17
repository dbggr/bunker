import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, noSandbox, review, type Agent } from "../src/index.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-review-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

async function branches(repo: string): Promise<string[]> {
  return (await $`git -C ${repo} branch ${"--format=%(refname:short)"}`.text()).trim().split("\n");
}

const APPROVE = "<review>APPROVE</review>";

// Implementer commits one file per round (N = commits so far). The reviewer's
// script is chosen per call; both see the prompt they were given in `prompts`.
function fakeAgent(reviewer: (n: number) => string, prompts: { write: string[]; review: string[] } = { write: [], review: [] }) {
  let reviews = 0;
  const agent: Agent = {
    command(prompt, mode = "write") {
      prompts[mode].push(prompt);
      if (mode === "write") {
        return ["sh", "-c", `N=$(git rev-list --count HEAD); echo $N > f$N.txt && git add . && git commit -qm "impl $N"`];
      }
      return ["sh", "-c", reviewer(++reviews)];
    },
  };
  return { agent, prompts };
}

describe("claudeCode() modes", () => {
  test("commit instruction only in write mode", () => {
    const write = claudeCode().command("x");
    expect(write[2]).toContain("commit your changes");
    expect(claudeCode().command("x", "write")[2]).toContain("commit your changes");
    const rev = claudeCode().command("x", "review");
    expect(rev[2]).toBe("x");
    expect(rev.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(rev).toContain("--dangerously-skip-permissions");
  });
});

describe("review()", () => {
  test("approved in round 1 → merged, branch deleted", async () => {
    const repo = await makeRepo();
    const { agent } = fakeAgent(() => `echo '${APPROVE}'`);
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.approved).toBe(true);
    expect(r.rounds[0]!.feedback).toContain(APPROVE);
    expect(r.commits.map((c) => c.subject)).toEqual(["impl 1"]);
    expect(await Bun.file(join(repo, "f1.txt")).exists()).toBe(true);
    expect(await branches(repo)).toEqual(["main"]);
  });

  test("reject then approve: round-2 implementer prompt has the feedback", async () => {
    const repo = await makeRepo();
    const { agent, prompts } = fakeAgent((n) => (n === 1 ? "echo 'rename foo'" : `echo '${APPROVE}'`));
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(r.rounds.map((x) => x.approved)).toEqual([false, true]);
    expect(r.rounds.map((x) => x.commits.map((c) => c.subject))).toEqual([["impl 1"], ["impl 2"]]);
    expect(r.commits).toHaveLength(2);
    expect(prompts.write[0]).toBe("do it");
    expect(prompts.write[1]).toContain("do it");
    expect(prompts.write[1]).toContain("A reviewer requested changes:\nrename foo");
  });

  test("never approved → rejected, not merged, branch kept", async () => {
    const repo = await makeRepo();
    const { agent } = fakeAgent(() => "echo 'no'");
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox(), maxRounds: 2 });
    expect(r.status).toBe("rejected");
    expect(r.rounds).toHaveLength(2);
    expect(await Bun.file(join(repo, "f1.txt")).exists()).toBe(false);
    expect(await branches(repo)).toContain(r.branch);
    const log = await $`git -C ${repo} log --format=%s ${r.branch}`.text();
    expect(log.split("\n")).toContain("impl 2");
  });

  test("reviewer edits and commits are discarded", async () => {
    const repo = await makeRepo();
    const { agent } = fakeAgent((n) =>
      n === 1
        ? `echo x > sneaky.txt && git add . && git commit -qm sneaky; echo y > stray.txt; echo nope`
        : `echo '${APPROVE}'`,
    );
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(r.commits.map((c) => c.subject)).toEqual(["impl 1", "impl 2"]);
    expect(await Bun.file(join(repo, "sneaky.txt")).exists()).toBe(false);
    expect(await Bun.file(join(repo, "stray.txt")).exists()).toBe(false);
  });

  test("reviewer prompt has the task, the diff and instructions", async () => {
    const repo = await makeRepo();
    const { agent, prompts } = fakeAgent(() => `echo '${APPROVE}'`);
    await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    const p = prompts.review[0]!;
    expect(p).toContain("do it");
    expect(p).toContain("+++ b/f1.txt");
    expect(p).toContain(APPROVE);
    expect(p).toMatch(/not modify/i);
  });

  test("custom reviewer and approveSignal", async () => {
    const repo = await makeRepo();
    const impl = fakeAgent(() => "exit 9");
    const rev = fakeAgent(() => "echo LGTM");
    const r = await review({ cwd: repo, prompt: "p", agent: impl.agent, reviewer: rev.agent, approveSignal: "LGTM", sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(impl.prompts.review).toHaveLength(0);
    expect(rev.prompts.review).toHaveLength(1);
  });

  test("implementer failure → failed, branch kept, not thrown", async () => {
    const repo = await makeRepo();
    const agent: Agent = { command: () => ["sh", "-c", "exit 3"] };
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("3");
    expect(await branches(repo)).toContain(r.branch);
  });

  test("reviewer failure → failed", async () => {
    const repo = await makeRepo();
    const { agent } = fakeAgent(() => "exit 5");
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("5");
    expect(await branches(repo)).toContain(r.branch);
  });

  test("merge conflict → conflict, branch kept", async () => {
    const repo = await makeRepo();
    // Implementer writes f1.txt in the worktree; meanwhile main gets its own f1.txt.
    const { agent } = fakeAgent(() => `echo '${APPROVE}'`);
    const wrapped: Agent = {
      command(p, mode) {
        const cmd = agent.command(p, mode);
        if (mode === "review") {
          return ["sh", "-c", `cd ${repo} && echo other > f1.txt && git add . && git commit -qm other; echo '${APPROVE}'`];
        }
        return cmd;
      },
    };
    const r = await review({ cwd: repo, prompt: "p", agent: wrapped, sandbox: noSandbox() });
    expect(r.status).toBe("conflict");
    expect(r.error).toContain("conflict");
    expect(await branches(repo)).toContain(r.branch);
  });

  test("worktree is always removed", async () => {
    const repo = await makeRepo();
    const { agent } = fakeAgent(() => "echo no");
    await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox(), maxRounds: 1 });
    const list = await $`git -C ${repo} worktree list --porcelain`.text();
    expect(list.match(/^worktree /gm)).toHaveLength(1);
  });
});
