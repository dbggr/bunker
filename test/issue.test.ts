import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent } from "../src/index.ts";
import { issueBranch, runIssue } from "../src/issue.ts";

const dirs: string[] = [];
const origPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = origPath;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("issueBranch()", () => {
  test("feature by default, fix with a bug label", () => {
    expect(issueBranch({ number: 5, title: "Add a thing", labels: [] })).toEqual({ branch: "feature/5-add-a-thing", slug: "add-a-thing" });
    expect(issueBranch({ number: 5, title: "Add a thing", labels: [{ name: "bug" }] }).branch).toBe("fix/5-add-a-thing");
    expect(issueBranch({ number: 5, title: "x", labels: [{ name: "enhancement" }, { name: "bug" }] }).branch).toBe("fix/5-x");
  });

  test("strips a conventional prefix", () => {
    expect(issueBranch({ number: 1, title: "feat: Issue to PR", labels: [] }).slug).toBe("issue-to-pr");
    expect(issueBranch({ number: 1, title: "fix(cli)!: Crash on start", labels: [] }).slug).toBe("crash-on-start");
    expect(issueBranch({ number: 1, title: "Feature flags", labels: [] }).slug).toBe("feature-flags");
  });

  test("non-alphanumerics collapse to single dashes, trimmed", () => {
    expect(issueBranch({ number: 1, title: "  Hello,   World!! (v2) ", labels: [] }).slug).toBe("hello-world-v2");
  });

  test("max 40 chars, no trailing dash", () => {
    const { slug } = issueBranch({ number: 1, title: "a".repeat(39) + " bbbbbbbb", labels: [] });
    expect(slug).toBe("a".repeat(39));
    expect(issueBranch({ number: 1, title: "word ".repeat(30), labels: [] }).slug.length).toBeLessThanOrEqual(40);
  });
});

const APPROVE = "<review>APPROVE</review>";

// Implementer commits one file; reviewer prints `verdict`. Records the prompts.
function fakeAgent(verdict: string, prompts: string[] = []): Agent {
  return {
    command(prompt, mode = "write") {
      if (mode === "write") {
        prompts.push(prompt);
        return ["sh", "-c", `echo hi > feature.txt && git add . && git commit -qm "feat: impl"`];
      }
      return ["sh", "-c", `echo '${verdict}'`];
    },
  };
}

interface Env {
  repo: string;
  origin: string;
  prLog: string;
}

// A repo with a bare local origin and a fake `gh` first on PATH.
async function setup(issue: object): Promise<Env> {
  const root = await tmp("bunker-issue-");
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const prLog = join(root, "pr.log");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} commit -q --allow-empty -m init`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await $`git -C ${repo} push -q -u origin main`;
  await $`mkdir ${bin}`;
  await Bun.write(join(root, "issue.json"), JSON.stringify(issue));
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "issue view" ]; then cat "${root}/issue.json"; exit 0; fi
if [ "$1 $2" = "pr create" ]; then
  shift 2
  for a in "$@"; do printf '%s\\n' "$a"; done > "${prLog}"
  echo "https://github.com/o/r/pull/99"
  exit 0
fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { repo, origin, prLog };
}

const issue = (extra: object = {}) => ({ number: 7, title: "feat: Add feature", body: "Make it so.", state: "OPEN", labels: [], ...extra });

async function originBranches(origin: string): Promise<string[]> {
  return (await $`git -C ${origin} branch ${"--format=%(refname:short)"}`.text()).trim().split("\n");
}

describe("runIssue()", () => {
  test("approved + verify passes → pushed, PR opened", async () => {
    const { repo, origin, prLog } = await setup(issue());
    const prompts: string[] = [];
    const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    const r = await runIssue({
      cwd: repo, issue: 7, agent: fakeAgent(APPROVE, prompts), sandbox: noSandbox(),
      verify: "test -f feature.txt",
    });
    expect(r.status).toBe("pr-opened");
    expect(r.branch).toBe("feature/7-add-feature");
    expect(r.worktree).toBe(join(repo, ".worktrees", "7-add-feature"));
    expect(r.prUrl).toBe("https://github.com/o/r/pull/99");
    expect(r.review?.status).toBe("approved");
    expect(await originBranches(origin)).toContain("feature/7-add-feature");
    const args = (await Bun.file(prLog).text()).split("\n");
    expect(args).toContain("feat: Add feature");
    const body = args.slice(args.indexOf("--body") + 1).join("\n");
    expect(body).toContain("Closes #7");
    expect(body).toContain("Verify: `test -f feature.txt` passed");
    expect(body).not.toMatch(/claude|generated|co-authored/i);
    expect(prompts[0]).toContain("Implement GitHub issue #7: feat: Add feature\n\nMake it so.");
    expect(prompts[0]).toMatch(/Conventional Commits/);
    // Worktree kept; caller's checkout and branch untouched.
    expect(await Bun.file(join(r.worktree, "feature.txt")).exists()).toBe(true);
    expect(await Bun.file(join(repo, "feature.txt")).exists()).toBe(false);
    expect((await $`git -C ${repo} rev-parse HEAD`.text()).trim()).toBe(head);
    expect((await $`git -C ${repo} branch --show-current`.text()).trim()).toBe("main");
    expect((await $`git -C ${repo} status --porcelain`.text()).trim()).toBe("");
  });

  test("no verify → PR without a Verify line", async () => {
    const { repo, prLog } = await setup(issue());
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox() });
    expect(r.status).toBe("pr-opened");
    const body = (await Bun.file(prLog).text()).split("\n");
    expect(body.join("\n")).not.toContain("Verify:");
    expect(body.join("\n")).toMatch(/Round 1/);
  });

  test("verify fails → nothing pushed, no PR, output tail returned", async () => {
    const { repo, origin, prLog } = await setup(issue());
    const r = await runIssue({
      cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox(),
      verify: "echo boom-output; exit 4",
    });
    expect(r.status).toBe("verify-failed");
    expect(r.verifyOutput).toContain("boom-output");
    expect(r.prUrl).toBeUndefined();
    expect(await originBranches(origin)).toEqual(["main"]);
    expect(await Bun.file(prLog).exists()).toBe(false);
    expect(await Bun.file(join(r.worktree, "feature.txt")).exists()).toBe(true);
  });

  test("rejected → nothing pushed, worktree kept", async () => {
    const { repo, origin, prLog } = await setup(issue());
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent("nope"), sandbox: noSandbox(), maxRounds: 1 });
    expect(r.status).toBe("rejected");
    expect(r.review?.status).toBe("rejected");
    expect(await originBranches(origin)).toEqual(["main"]);
    expect(await Bun.file(prLog).exists()).toBe(false);
    expect(await Bun.file(r.worktree + "/.git").exists()).toBe(true);
  });

  test("agent failure → failed, not thrown", async () => {
    const { repo } = await setup(issue());
    const agent: Agent = { command: () => ["sh", "-c", "exit 3"] };
    const r = await runIssue({ cwd: repo, issue: 7, agent, sandbox: noSandbox() });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("3");
  });

  test("closed issue → throws, nothing created", async () => {
    const { repo } = await setup(issue({ state: "CLOSED" }));
    await expect(runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox() })).rejects.toThrow(/closed/i);
    expect(await Bun.file(join(repo, ".worktrees")).exists()).toBe(false);
    expect((await $`git -C ${repo} branch ${"--format=%(refname:short)"}`.text()).trim()).toBe("main");
  });

  test("bug label → fix/ branch", async () => {
    const { repo, origin } = await setup(issue({ labels: [{ name: "bug" }] }));
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox() });
    expect(r.branch).toBe("fix/7-add-feature");
    expect(await originBranches(origin)).toContain("fix/7-add-feature");
  });
});
