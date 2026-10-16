import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { noSandbox, type Agent } from "../src/index.ts";
import { issueBranch, runIssue } from "../src/issue.ts";

const dirs: string[] = [];
const origPath = process.env.PATH;
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "BUNKER_GH_TOKEN"];
const origTokens = Object.fromEntries(TOKEN_VARS.map((k) => [k, process.env[k]]));
// Tests must not depend on (or print) whatever token the outer env exports.
beforeEach(() => {
  for (const k of TOKEN_VARS) delete process.env[k];
});
afterEach(async () => {
  process.env.PATH = origPath;
  for (const k of TOKEN_VARS) {
    if (origTokens[k] === undefined) delete process.env[k];
    else process.env[k] = origTokens[k];
  }
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
  });

  test("cuts at the last whole word, not mid-word", () => {
    const title = "make the branch slug stop cutting words in half";
    expect(issueBranch({ number: 1, title, labels: [] }).slug).toBe("make-the-branch-slug-stop-cutting-words");
    expect(issueBranch({ number: 1, title: "a".repeat(50), labels: [] }).slug).toBe("a".repeat(40));
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
  mergeLog: string;
}

// A repo with a bare local origin and a fake `gh` first on PATH.
async function setup(issue: object, mergeMode: "ff" | "drop" | "fail" | "none" | "closed" | "never" | "noauto" | "noauto-protected" = "none"): Promise<Env> {
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
LAND='git --git-dir="${origin}" update-ref refs/heads/main refs/heads/feature/7-add-feature${mergeMode === "drop" ? "~1" : ""}'
if [ "$1 $2" = "pr merge" ]; then
  echo "$GH_TOKEN|$*" >> "${root}/merge.log"
  case "$*" in
    *--auto*)
      ${
        mergeMode === "fail"
          ? 'echo "boom: no permission" >&2; exit 1'
          : mergeMode.startsWith("noauto")
            ? 'echo "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)" >&2; exit 1'
            : `touch "${root}/armed"; exit 0`
      };;
    *)
      ${
        mergeMode === "noauto-protected"
          ? 'echo "X Pull request is not mergeable: the base branch policy prohibits the merge" >&2; exit 1'
          : `eval "$LAND"; touch "${root}/merged"; exit 0`
      };;
  esac
fi
if [ "$1 $2" = "pr view" ]; then
  echo "$*" >> "${root}/view.log"
  if [ -f "${root}/merged" ]; then echo '{"state":"MERGED","mergeCommit":{"oid":"abc"}}'; exit 0; fi
  if [ -f "${root}/armed" ]; then
    if [ ! -f "${root}/seen" ]; then touch "${root}/seen"; echo '{"state":"OPEN","mergeCommit":null}'; exit 0; fi
    ${
      mergeMode === "closed"
        ? `echo '{"state":"CLOSED","mergeCommit":null}'; exit 0`
        : mergeMode === "never"
          ? `echo '{"state":"OPEN","mergeCommit":null}'; exit 0`
          : `eval "$LAND"; touch "${root}/merged"; echo '{"state":"MERGED","mergeCommit":{"oid":"abc"}}'; exit 0`
    }
  fi
  echo '{"state":"OPEN","mergeCommit":null}'
  exit 0
fi
if [ "$1 $2" = "pr close" ] || [ "$1 $2" = "pr reopen" ]; then echo "$1 $2" >> "${root}/reopen.log"; exit 0; fi
if [ "$1" = "api" ]; then
  echo "$*" >> "${root}/api.log"
  exit 0
fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { repo, origin, prLog, mergeLog: join(root, "merge.log") };
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

  test("includes issue comments, oldest first with author, in the agent prompt", async () => {
    const { repo } = await setup(issue({
      comments: [
        { author: { login: "alice" }, body: "First: also do X.", createdAt: "2026-01-01T00:00:00Z" },
        { author: { login: "bob" }, body: "Second: and Y.", createdAt: "2026-01-02T00:00:00Z" },
      ],
    }));
    const prompts: string[] = [];
    await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE, prompts), sandbox: noSandbox() });
    expect(prompts[0]).toContain("Make it so.");
    const a = prompts[0]!.indexOf("@alice");
    const b = prompts[0]!.indexOf("@bob");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(prompts[0]).toContain("First: also do X.");
    expect(prompts[0]).toContain("Second: and Y.");
  });

  test("an issue without comments gets no comments section", async () => {
    const { repo } = await setup(issue({ comments: [] }));
    const prompts: string[] = [];
    await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE, prompts), sandbox: noSandbox() });
    expect(prompts[0]).not.toMatch(/comments/i);
  });

  test("writes a per-run log under .bunker/runs, excluded from git status", async () => {
    const { repo } = await setup(issue());
    process.env.BUNKER_GH_TOKEN = "secret-token-value";
    let r;
    try {
      r = await runIssue({
        cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox(),
        verify: "echo verify-says-hi secret-token-value; exit 3",
      });
    } finally {
      delete process.env.BUNKER_GH_TOKEN;
    }
    expect(r.status).toBe("verify-failed");
    expect(dirname(r.logPath!)).toBe(join(repo, ".bunker", "runs"));
    expect(r.logPath).toMatch(/\/7-[^/]+\.log$/);
    const log = await Bun.file(r.logPath!).text();
    expect(log).toContain("verify-says-hi");
    expect(log).toContain("verify-failed");
    expect(log).toContain(APPROVE);
    expect(log).not.toContain("secret-token-value");
    expect((await $`git -C ${repo} status --porcelain`.text()).trim()).toBe("");
  });

  for (const token of [false, true]) {
    test(`pr create gets --head <branch> (BUNKER_GH_TOKEN ${token ? "set" : "unset"})`, async () => {
      const { repo, prLog } = await setup(issue());
      if (token) process.env.BUNKER_GH_TOKEN = "scoped-token";
      try {
        const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox() });
        expect(r.status).toBe("pr-opened");
      } finally {
        delete process.env.BUNKER_GH_TOKEN;
      }
      const args = (await Bun.file(prLog).text()).split("\n");
      expect(args[args.indexOf("--head") + 1]).toBe("feature/7-add-feature");
    });
  }

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

  test("verify runs in the sandbox by default, not on the host", async () => {
    const { repo } = await setup(issue());
    const calls: string[][] = [];
    const inner = noSandbox();
    const sandbox = { exec: (cmd: string[], ctx: { worktree: string; gitCommonDir: string }) => (calls.push(cmd), inner.exec(cmd, ctx)) };
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox, verify: "echo VERIFYME; exit 4" });
    expect(r.status).toBe("verify-failed");
    expect(r.verifyOutput).toContain("VERIFYME");
    expect(calls.some((c) => c.join(" ").includes("VERIFYME"))).toBe(true);
  });

  test("verifyOnHost runs verify on the host, not in the sandbox", async () => {
    const { repo } = await setup(issue());
    const calls: string[][] = [];
    const inner = noSandbox();
    const sandbox = { exec: (cmd: string[], ctx: { worktree: string; gitCommonDir: string }) => (calls.push(cmd), inner.exec(cmd, ctx)) };
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox, verify: "echo ONHOST; exit 4", verifyOnHost: true });
    expect(r.status).toBe("verify-failed");
    expect(r.verifyOutput).toContain("ONHOST");
    expect(calls.some((c) => c.join(" ").includes("ONHOST"))).toBe(false);
  });

  test("setup runs in the sandbox before the agent; agent sees its output", async () => {
    const { repo } = await setup(issue());
    const calls: string[][] = [];
    const inner = noSandbox();
    const sandbox = { exec: (cmd: string[], ctx: { worktree: string; gitCommonDir: string }) => (calls.push(cmd), inner.exec(cmd, ctx)) };
    const agent: Agent = {
      command: (_p, mode = "write") =>
        mode === "write"
          ? ["sh", "-c", `cp setup.out feature.txt && git add feature.txt && git commit -qm "feat: impl"`]
          : ["sh", "-c", `echo '${APPROVE}'`],
    };
    const r = await runIssue({ cwd: repo, issue: 7, agent, sandbox, setup: "echo SETUPME > setup.out" });
    expect(r.status).toBe("pr-opened");
    expect((await Bun.file(join(r.worktree, "feature.txt")).text()).trim()).toBe("SETUPME");
    expect(calls.findIndex((c) => c.join(" ").includes("SETUPME"))).toBe(0);
  });

  test("failing setup → failed with its output, agent never runs", async () => {
    const { repo, origin } = await setup(issue());
    const prompts: string[] = [];
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE, prompts), sandbox: noSandbox(), setup: "echo setup-boom; exit 5" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("setup-boom");
    expect(prompts).toEqual([]);
    expect(await originBranches(origin)).toEqual(["main"]);
  });

  test(".bunker/setup is the default; explicit setup overrides it", async () => {
    const { repo } = await setup(issue());
    await $`mkdir -p ${repo}/.bunker`;
    await Bun.write(join(repo, ".bunker", "setup"), "echo FROMFILE > setup.out\n");
    await $`git -C ${repo} add .bunker/setup && git -C ${repo} commit -qm "chore: setup" && git -C ${repo} push -q origin main`;
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox() });
    expect(r.status).toBe("pr-opened");
    expect((await Bun.file(join(r.worktree, "setup.out")).text()).trim()).toBe("FROMFILE");
    await $`git -C ${repo} worktree remove --force ${r.worktree} && git -C ${repo} branch -D ${r.branch}`.quiet();
    const r2 = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox(), setup: "echo EXPLICIT > setup.out" });
    expect((await Bun.file(join(r2.worktree, "setup.out")).text()).trim()).toBe("EXPLICIT");
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

  test("branches from origin's main, not a stale local HEAD", async () => {
    const { repo, origin } = await setup(issue());
    const other = join(repo, "..", "other");
    await $`git clone -q ${origin} ${other}`;
    await $`git -C ${other} config user.name Test`;
    await $`git -C ${other} config user.email test@example.com`;
    await $`git -C ${other} commit -q --allow-empty -m upstream`;
    await $`git -C ${other} push -q origin main`;
    const upstream = (await $`git -C ${other} rev-parse HEAD`.text()).trim();
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox() });
    expect(r.status).toBe("pr-opened");
    const base = (await $`git -C ${origin} rev-parse ${r.branch}~1`.text()).trim();
    expect(base).toBe(upstream);
  });

  test("bug label → fix/ branch", async () => {
    const { repo, origin } = await setup(issue({ labels: [{ name: "bug" }] }));
    const r = await runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox() });
    expect(r.branch).toBe("fix/7-add-feature");
    expect(await originBranches(origin)).toContain("fix/7-add-feature");
  });
});

describe("runIssue() --merge", () => {
  const run = (repo: string, extra: object = {}) =>
    runIssue({ cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10, ...extra });
  const branches = async (repo: string) => (await $`git -C ${repo} branch ${"--format=%(refname:short)"}`.text()).trim().split("\n");

  test("auto-merge armed, PR becomes MERGED → landing check, cleanup, merged", async () => {
    const { repo, origin, mergeLog } = await setup(issue(), "ff");
    const r = await run(repo);
    expect(r.status).toBe("merged");
    expect(r.prUrl).toBe("https://github.com/o/r/pull/99");
    expect((await Bun.file(mergeLog).text()).trim()).toBe("|pr merge https://github.com/o/r/pull/99 --auto --squash");
    const views = (await Bun.file(join(dirname(mergeLog), "view.log")).text()).trim().split("\n");
    expect(views.every((v) => v === "pr view https://github.com/o/r/pull/99 --json state,mergeCommit")).toBe(true);
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect((await Bun.file(join(dirname(mergeLog), "api.log")).text()).trim()).toBe(
      "api -X DELETE repos/{owner}/{repo}/git/refs/heads/feature/7-add-feature",
    );
    expect(await Bun.file(join(r.worktree, ".git")).exists()).toBe(false);
    expect(await branches(repo)).toEqual(["main"]);
    expect((await $`git -C ${origin} show main:feature.txt`.text()).trim()).toBe("hi");
  });

  test("dropped commit → merge-unverified, worktree and branch kept", async () => {
    const { repo } = await setup(issue(), "drop");
    const r = await run(repo);
    expect(r.status).toBe("merge-unverified");
    expect(r.error).toContain("feature.txt");
    expect(await Bun.file(join(r.worktree, ".git")).exists()).toBe(true);
    expect(await branches(repo)).toContain(r.branch);
  });

  test("arming fails → merge-failed with the full error, PR left open, worktree kept", async () => {
    const { repo } = await setup(issue(), "fail");
    const r = await run(repo);
    expect(r.status).toBe("merge-failed");
    expect(r.error).toContain("boom: no permission");
    expect(r.prUrl).toBe("https://github.com/o/r/pull/99");
    expect(await Bun.file(join(r.worktree, ".git")).exists()).toBe(true);
  });

  test("PR closed without merging → merge-failed, worktree kept", async () => {
    const { repo } = await setup(issue(), "closed");
    const r = await run(repo);
    expect(r.status).toBe("merge-failed");
    expect(r.error).toContain("CLOSED");
    expect(await Bun.file(join(r.worktree, ".git")).exists()).toBe(true);
  });

  test("never merges → ci-timeout, PR left open, auto-merge stays armed, worktree kept", async () => {
    const { repo, mergeLog } = await setup(issue(), "never");
    const r = await run(repo, { ciTimeoutMin: 0.002 });
    expect(r.status).toBe("ci-timeout");
    expect(r.prUrl).toBe("https://github.com/o/r/pull/99");
    expect((await Bun.file(mergeLog).text()).trim().split("\n")).toHaveLength(1);
    expect(await Bun.file(join(r.worktree, ".git")).exists()).toBe(true);
    expect(await Bun.file(join(dirname(mergeLog), "api.log")).exists()).toBe(false);
  });

  test("auto-merge not allowed → plain squash merge fallback → merged", async () => {
    const { repo, mergeLog } = await setup(issue(), "noauto");
    const r = await run(repo);
    expect(r.status).toBe("merged");
    expect((await Bun.file(mergeLog).text()).trim().split("\n")).toEqual([
      "|pr merge https://github.com/o/r/pull/99 --auto --squash",
      "|pr merge https://github.com/o/r/pull/99 --squash",
    ]);
    expect(await branches(repo)).toEqual(["main"]);
  });

  test("auto-merge not allowed and plain merge refused by protection → merge-failed, PR left open", async () => {
    const { repo } = await setup(issue(), "noauto-protected");
    const r = await run(repo);
    expect(r.status).toBe("merge-failed");
    expect(r.error).toContain("base branch policy");
    expect(await Bun.file(join(r.worktree, ".git")).exists()).toBe(true);
  });

  test("no merge flag → never calls pr merge", async () => {
    const { repo, mergeLog } = await setup(issue(), "ff");
    const r = await run(repo, { merge: false });
    expect(r.status).toBe("pr-opened");
    expect(await Bun.file(mergeLog).exists()).toBe(false);
  });

  test("BUNKER_GH_TOKEN is passed to gh as GH_TOKEN", async () => {
    const { repo, mergeLog } = await setup(issue(), "ff");
    process.env.BUNKER_GH_TOKEN = "scoped-token";
    try {
      expect((await run(repo)).status).toBe("merged");
    } finally {
      delete process.env.BUNKER_GH_TOKEN;
    }
    expect((await Bun.file(mergeLog).text()).startsWith("scoped-token|")).toBe(true);
  });
});

describe("noSandbox() token isolation", () => {
  test("agent can't see GH_TOKEN, GITHUB_TOKEN or BUNKER_GH_TOKEN", async () => {
    const dir = await tmp("bunker-env-");
    const saved = { ...process.env };
    Object.assign(process.env, { GH_TOKEN: "a", GITHUB_TOKEN: "b", BUNKER_GH_TOKEN: "c", KEEP_ME: "d" });
    try {
      const r = await noSandbox().exec(["sh", "-c", 'echo "[$GH_TOKEN|$GITHUB_TOKEN|$BUNKER_GH_TOKEN|$KEEP_ME]"'], { worktree: dir, gitCommonDir: dir });
      expect(r.stdout.trim()).toBe("[|||d]");
    } finally {
      for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "BUNKER_GH_TOKEN", "KEEP_ME"]) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("redaction", () => {
  test("a verify failure that prints a token comes back redacted", async () => {
    const { repo } = await setup(issue());
    process.env.GH_TOKEN = "super-secret-token-value";
    const r = await runIssue({
      cwd: repo, issue: 7, agent: fakeAgent(APPROVE), sandbox: noSandbox(),
      verify: "echo $GH_TOKEN; echo ghp_abcdefghijklmnopqrstuvwxyz0123; exit 4", verifyOnHost: true,
    });
    expect(r.status).toBe("verify-failed");
    expect(r.verifyOutput).toContain("[REDACTED]");
    expect(r.verifyOutput).not.toContain("super-secret-token-value");
    expect(r.verifyOutput).not.toContain("ghp_");
  });
});
