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

const APPROVE = "<verdict>{\"approved\":true,\"required_changes\":[]}</verdict>";

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
    expect(claudeCode().input?.("x", "write")).toContain("commit your changes");
    
    const rev = claudeCode().command("x", "review");
    expect(claudeCode().input?.("x", "review")).toBe("x");
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
    const { agent, prompts } = fakeAgent((n) => (n === 1 ? `echo '<verdict>{"approved":false,"required_changes":["rename foo"]}</verdict>'` : `echo '${APPROVE}'`));
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(r.rounds.map((x) => x.approved)).toEqual([false, true]);
    expect(r.rounds.map((x) => x.commits.map((c) => c.subject))).toEqual([["impl 1"], ["impl 2"]]);
    expect(r.commits).toHaveLength(2);
    expect(prompts.write[0]).toBe("do it");
    expect(prompts.write[1]).toContain("do it");
    expect(prompts.write[1]).toContain("A reviewer requested changes:\n- rename foo");
  });

  test("never approved → rejected, not merged, branch kept", async () => {
    const repo = await makeRepo();
    const { agent } = fakeAgent(() => `echo '<verdict>{"approved":false,"required_changes":["no"]}</verdict>'`);
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
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
        ? `echo x > sneaky.txt && git add . && git commit -qm sneaky; echo y > stray.txt; echo '<verdict>{"approved":false,"required_changes":["nope"]}</verdict>'`
        : `echo '${APPROVE}'`,
    );
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(r.commits.map((c) => c.subject)).toEqual(["impl 1", "impl 2"]);
    expect(await Bun.file(join(repo, "sneaky.txt")).exists()).toBe(false);
    expect(await Bun.file(join(repo, "stray.txt")).exists()).toBe(false);
  });

  test("the reviewer sees the base branch's CLAUDE.md and .claude/, not the agent's", async () => {
    const repo = await makeRepo();
    await Bun.write(join(repo, "CLAUDE.md"), "base\n");
    await Bun.write(join(repo, "sub/AGENTS.md"), "base-agents\n");
    await $`git -C ${repo} add -A && git -C ${repo} commit -qm base`;
    const seen = join(await mkdtemp(join(tmpdir(), "bunker-seen-")), "seen");
    dirs.push(join(seen, ".."));
    const agent: Agent = {
      command(_p, mode = "write") {
        if (mode === "write") return ["sh", "-c", `echo evil > CLAUDE.md && echo evil > sub/AGENTS.md && mkdir -p .claude/skills/x && echo evil > .claude/skills/x/SKILL.md && echo 1 > f.txt && git add -A && git commit -qm impl`];
        return ["sh", "-c", `{ cat CLAUDE.md sub/AGENTS.md; ls .claude 2>&1; } > ${seen}; echo '${APPROVE}'`];
      },
    };
    const r = await review({ cwd: repo, prompt: "x", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    const out = await Bun.file(seen).text();
    expect(out).toContain("base");
    expect(out).toContain("base-agents");
    expect(out).not.toContain("evil");
    expect(out).toContain("No such file");
    // The agent's version is what gets merged.
    expect(await Bun.file(join(repo, "CLAUDE.md")).text()).toBe("evil\n");
  });

  test("gitignored steering files are hidden from the reviewer and back afterwards", async () => {
    const repo = await makeRepo();
    await Bun.write(join(repo, ".gitignore"), ".claude/\nCLAUDE.local.md\n");
    await $`git -C ${repo} add -A && git -C ${repo} commit -qm ignore`;
    const seen = join(await mkdtemp(join(tmpdir(), "bunker-seen-")), "seen");
    dirs.push(join(seen, ".."));
    const agent: Agent = {
      command(_p, mode = "write") {
        if (mode === "write") return ["sh", "-c", `mkdir -p .claude && echo evil > .claude/settings.local.json && echo evil > CLAUDE.local.md && echo 1 > f.txt && git add -A && git commit -qm impl`];
        return ["sh", "-c", `{ ls -A .claude 2>&1; ls CLAUDE.local.md 2>&1; } > ${seen}; echo '${APPROVE}'`];
      },
    };
    const r = await review({ cwd: repo, prompt: "x", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    const out = await Bun.file(seen).text();
    expect(out).not.toContain("settings.local.json");
    expect(out).toContain("No such file");
  });

  test("reviewer prompt has the task, the diff and instructions", async () => {
    const repo = await makeRepo();
    const { agent, prompts } = fakeAgent(() => `echo '${APPROVE}'`);
    await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    const p = prompts.review[0]!;
    expect(p).toContain("do it");
    expect(p).toContain("+++ b/f1.txt");
    expect(p).toContain("<verdict>");
    expect(p).toMatch(/not modify/i);
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

  test("a reviewer that dies mid-response is retried once and the approval stands", async () => {
    const repo = await makeRepo();
    const { agent, prompts } = fakeAgent((n) => (n === 1 ? "exit 1" : `echo '${APPROVE}'`));
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(prompts.review).toHaveLength(2);
  });

  test("a reviewer that fails twice is not retried a third time", async () => {
    const repo = await makeRepo();
    const { agent, prompts } = fakeAgent(() => "exit 1");
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.status).toBe("failed");
    expect(prompts.review).toHaveLength(2);
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
    const { agent } = fakeAgent(() => `echo '<verdict>{"approved":false,"required_changes":["no"]}</verdict>'`);
    await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox(), maxRounds: 1 });
    const list = await $`git -C ${repo} worktree list --porcelain`.text();
    expect(list.match(/^worktree /gm)).toHaveLength(1);
  });
});

describe("review() structured verdict", () => {
  const verdict = (v: object) => `<verdict>${JSON.stringify(v)}</verdict>`;
  const say = (s: string) => `cat <<'EOF_'\n${s}\nEOF_`;

  test("verdict approved parsed; issues kept with backticks", async () => {
    const repo = await makeRepo();
    const v = verdict({ approved: true, issues: [{ title: "T", body: "see `x.ts`" }] });
    const { agent } = fakeAgent(() => say(v));
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(r.rounds[0]!.verdict?.issues).toEqual([{ title: "T", body: "see `x.ts`" }]);
  });

  test("approved:false rejects; required_changes feed the next round", async () => {
    const repo = await makeRepo();
    const { agent, prompts } = fakeAgent((n) => say(n === 1 ? verdict({ approved: false, required_changes: ["rename foo"] }) : verdict({ approved: true })));
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.rounds.map((x) => x.approved)).toEqual([false, true]);
    expect(prompts.write[1]).toContain("rename foo");
  });

  test("quoted verdict in prose is ignored (last wins)", async () => {
    const repo = await makeRepo();
    const { agent } = fakeAgent(() => say(`I would say ${verdict({ approved: true })} if good.\n${verdict({ approved: false })}`));
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox(), maxRounds: 1 });
    expect(r.status).toBe("rejected");
  });

  test("invalid JSON → retry naming the error → success", async () => {
    const repo = await makeRepo();
    const prompts = { write: [] as string[], review: [] as string[] };
    const { agent } = fakeAgent((n) => say(n === 1 ? "<verdict>{oops</verdict>" : verdict({ approved: true })), prompts);
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(prompts.review).toHaveLength(2);
    expect(prompts.review[1]).toContain("invalid JSON");
    expect(prompts.write).toHaveLength(1);
  });

  test("still invalid after maxRetries → bad-output", async () => {
    const repo = await makeRepo();
    const prompts = { write: [] as string[], review: [] as string[] };
    const { agent } = fakeAgent(() => say("no verdict here"), prompts);
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox(), maxRetries: 1 });
    expect(r.status).toBe("bad-output");
    expect(r.error).toContain("verdict");
    expect(prompts.review).toHaveLength(2);
  });

  test("implementer <report> parsed", async () => {
    const repo = await makeRepo();
    const agent: Agent = {
      command(_p, mode = "write") {
        if (mode === "review") return ["sh", "-c", say(verdict({ approved: true }))];
        return ["sh", "-c", `echo a > a.txt && git add . && git commit -qm a && ${say('<report>{"blocked_by":[{"title":"B","body":"b"}]}</report>')}`];
      },
    };
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox() });
    expect(r.rounds[0]!.report?.blocked_by).toEqual([{ title: "B", body: "b" }]);
  });

  test("an invalid <report> is noted and exposed, not silently dropped", async () => {
    const repo = await makeRepo();
    const events: string[] = [];
    const agent: Agent = {
      command(_p, mode = "write") {
        if (mode === "review") return ["sh", "-c", say(verdict({ approved: true }))];
        return ["sh", "-c", `echo a > a.txt && git add . && git commit -qm a && ${say('<report>{oops</report> <issue title="Quoted">body</issue>')}`];
      },
    };
    const r = await review({ cwd: repo, prompt: "p", agent, sandbox: noSandbox(), onEvent: (e) => void (e.text && events.push(e.text)) });
    expect(r.rounds[0]!.report).toBeUndefined();
    expect(r.rounds[0]!.reportError).toContain("invalid JSON");
    expect(events.some((t) => t.includes("<report>") && t.includes("invalid JSON"))).toBe(true);
  });
});
