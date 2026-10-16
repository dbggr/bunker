import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, docker, noSandbox, run, runAll, type Agent } from "../src/index.ts";

const dirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-test-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

// Stands in for claude: a shell script that edits a file and commits it.
function fakeAgent(script: string): Agent {
  return { command: () => ["sh", "-c", script] };
}

const commitsA = fakeAgent("echo hi > a.txt && git add a.txt && git commit -qm 'agent: add a'");

async function branches(repo: string): Promise<string[]> {
  const out = await $`git -C ${repo} branch ${"--format=%(refname:short)"}`.text();
  return out.trim().split("\n");
}

async function worktreeCount(repo: string): Promise<number> {
  const out = await $`git -C ${repo} worktree list --porcelain`.text();
  return out.split("\n").filter((l) => l.startsWith("worktree ")).length;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("run() with noSandbox", () => {
  test("returns the agent's commits and merges them into the caller's branch", async () => {
    const repo = await makeRepo();

    const result = await run({ cwd: repo, prompt: "add a", agent: commitsA, sandbox: noSandbox() });

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]?.subject).toBe("agent: add a");
    expect(await Bun.file(join(repo, "a.txt")).text()).toBe("hi\n");
    expect(await $`git -C ${repo} log -1 --format=%s`.text()).toBe("agent: add a\n");
  });

  test("removes the worktree and the bunker branch afterwards", async () => {
    const repo = await makeRepo();

    await run({ cwd: repo, prompt: "add a", agent: commitsA, sandbox: noSandbox() });

    expect(await branches(repo)).toEqual(["main"]);
    expect(await worktreeCount(repo)).toBe(1);
  });

  test("an agent that commits nothing returns no commits and leaves HEAD alone", async () => {
    const repo = await makeRepo();
    const before = await $`git -C ${repo} rev-parse HEAD`.text();

    const result = await run({ cwd: repo, prompt: "noop", agent: fakeAgent("true"), sandbox: noSandbox() });

    expect(result.commits).toEqual([]);
    expect(await $`git -C ${repo} rev-parse HEAD`.text()).toBe(before);
    expect(await branches(repo)).toEqual(["main"]);
  });

  test("a failing agent throws, removes the worktree, and keeps the branch for inspection", async () => {
    const repo = await makeRepo();
    const agent = fakeAgent("echo x > x.txt && git add x.txt && git commit -qm partial && exit 3");

    await expect(run({ cwd: repo, prompt: "fail", agent, sandbox: noSandbox() })).rejects.toThrow(/exited with 3/);

    expect(await worktreeCount(repo)).toBe(1);
    expect((await branches(repo)).some((b) => b.startsWith("bunker/"))).toBe(true);
    expect(await Bun.file(join(repo, "x.txt")).exists()).toBe(false);
  });

  test("env set at runtime (e.g. from .bunker/.env) reaches the agent", async () => {
    const repo = await makeRepo();
    process.env.BUNKER_TEST_RUNTIME_VAR = "from-runtime";
    const agent = fakeAgent('printf %s "$BUNKER_TEST_RUNTIME_VAR" > v.txt && git add v.txt && git commit -qm v');

    try {
      await run({ cwd: repo, prompt: "x", agent, sandbox: noSandbox() });
    } finally {
      delete process.env.BUNKER_TEST_RUNTIME_VAR;
    }

    expect(await Bun.file(join(repo, "v.txt")).text()).toBe("from-runtime");
  });

  test("the agent runs inside the worktree, not the caller's checkout", async () => {
    const repo = await makeRepo();
    const agent = fakeAgent("pwd > where.txt && git add where.txt && git commit -qm where");

    await run({ cwd: repo, prompt: "where", agent, sandbox: noSandbox() });

    const where = (await Bun.file(join(repo, "where.txt")).text()).trim();
    expect(where).not.toBe(repo);
    expect(where).toContain("bunker");
  });
});

describe("claudeCode()", () => {
  test("builds a headless claude command with the prompt", () => {
    const cmd = claudeCode().command("fix the bug");
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd.some((a) => a.includes("fix the bug"))).toBe(true);
  });

  test("passes a model through", () => {
    expect(claudeCode({ model: "claude-sonnet-5-5" }).command("x")).toContain("claude-sonnet-5-5");
  });
});

const dockerUp = (await $`docker info`.quiet().nothrow()).exitCode === 0;
const GIT_IMAGE = "bunker-test-git";

describe.skipIf(!dockerUp)("run() with docker", () => {
  beforeAll(async () => {
    await $`printf 'FROM alpine:3\nRUN apk add --no-cache git\n' | docker build -q -t ${GIT_IMAGE} -`.quiet();
  }, 120_000);

  afterAll(async () => {
    const repos = (await $`docker image ls ${"--format={{.Repository}}"}`.text()).split("\n");
    const tags = repos.filter((r) => r.startsWith("bunker-repo-bunker-test-"));
    if (tags.length) await $`docker image rm -f ${tags}`.quiet();
  });

  test("runs the agent in a container and merges its commits back", async () => {
    const repo = await makeRepo();
    const agent = fakeAgent(
      "cat /etc/alpine-release > os.txt && git add os.txt && git commit -qm 'agent: from container'",
    );

    const result = await run({ cwd: repo, prompt: "x", agent, sandbox: docker({ image: GIT_IMAGE }) });

    expect(result.commits.map((c) => c.subject)).toEqual(["agent: from container"]);
    expect((await Bun.file(join(repo, "os.txt")).text()).trim()).toMatch(/^\d+\.\d+/);
  }, 60_000);

  test("env set at runtime is forwarded into the container", async () => {
    const repo = await makeRepo();
    process.env.BUNKER_TEST_RUNTIME_VAR = "into-container";
    const agent = fakeAgent('printf %s "$BUNKER_TEST_RUNTIME_VAR" > v.txt && git add v.txt && git commit -qm v');

    try {
      await run({
        cwd: repo,
        prompt: "x",
        agent,
        sandbox: docker({ image: GIT_IMAGE, env: ["BUNKER_TEST_RUNTIME_VAR"] }),
      });
    } finally {
      delete process.env.BUNKER_TEST_RUNTIME_VAR;
    }

    expect(await Bun.file(join(repo, "v.txt")).text()).toBe("into-container");
  }, 60_000);

  test("builds and uses the repo's .bunker/Dockerfile", async () => {
    const repo = await makeRepo();
    await Bun.write(join(repo, ".bunker/Dockerfile"), `FROM ${GIT_IMAGE}\nRUN echo extended > /extended\n`);
    await $`git -C ${repo} add .bunker && git -C ${repo} commit -qm bunker-image`;
    const agent = fakeAgent("cp /extended e.txt && git add e.txt && git commit -qm extended");

    await run({ cwd: repo, prompt: "x", agent, sandbox: docker({ baseImage: GIT_IMAGE }) });

    expect(await Bun.file(join(repo, "e.txt")).text()).toBe("extended\n");
  }, 120_000);

  test("parallel agents share one build of the repo image", async () => {
    const repo = await makeRepo();
    await Bun.write(join(repo, ".bunker/Dockerfile"), `FROM ${GIT_IMAGE}\n`);
    await $`git -C ${repo} add .bunker && git -C ${repo} commit -qm bunker-image`;
    const builds: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((msg: unknown) => {
      if (String(msg).includes("building")) builds.push(String(msg));
    });

    try {
      const results = await runAll({
        cwd: repo,
        agent: { command: (p) => ["sh", "-c", p] },
        sandbox: docker({ baseImage: GIT_IMAGE }),
        tasks: [{ prompt: "true" }, { prompt: "true" }, { prompt: "true" }],
      });
      expect(results.map((r) => r.status)).toEqual(["merged", "merged", "merged"]);
    } finally {
      spy.mockRestore();
    }

    expect(builds).toHaveLength(1);
  }, 120_000);

  test("an explicit image overrides the repo's .bunker/Dockerfile", async () => {
    const repo = await makeRepo();
    await Bun.write(join(repo, ".bunker/Dockerfile"), "FROM bunker-no-such-image\n");
    await $`git -C ${repo} add .bunker && git -C ${repo} commit -qm broken-image`;

    const result = await run({ cwd: repo, prompt: "x", agent: commitsA, sandbox: docker({ image: GIT_IMAGE }) });

    expect(result.commits.map((c) => c.subject)).toEqual(["agent: add a"]);
  }, 60_000);

  test("files are owned by the host user, not root", async () => {
    const repo = await makeRepo();
    const agent = fakeAgent("touch owned.txt && git add owned.txt && git commit -qm owned");

    await run({ cwd: repo, prompt: "x", agent, sandbox: docker({ image: GIT_IMAGE }) });

    const uid = (await $`stat -c %u ${join(repo, "owned.txt")}`.text()).trim();
    expect(uid).toBe(String(process.getuid?.()));
    // git objects written inside the container must not be root-owned either
    expect((await $`find ${join(repo, ".git")} -not -user ${uid}`.text()).trim()).toBe("");
  }, 60_000);
});
