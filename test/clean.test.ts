import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClean } from "../src/clean.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
const extraDirs: string[] = [];
afterEach(async () => {
  process.env.PATH = origPath;
  await Promise.all([...dirs.splice(0), ...extraDirs.splice(0)].map((d) => rm(d, { recursive: true, force: true })));
});

/** A repo with a bare origin and a fake gh answering from files: issue-<n>.json and pr-<branch with / as _>.json. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bunker-clean-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} commit -q --allow-empty -m init`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await $`git -C ${repo} push -q -u origin main`;
  await mkdir(bin);
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "issue view" ] && [ -f "${root}/issue-$3.json" ]; then cat "${root}/issue-$3.json"; exit 0; fi
if [ "$1 $2" = "pr list" ]; then f="${root}/pr-$(echo "$4" | tr '/' '_').json"; if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi; exit 0; fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  // Never let a test reach the real docker daemon: `clean --images --yes` would `docker rmi` the host's bunker-repo-* images.
  await Bun.write(join(bin, "docker"), `#!/bin/sh\necho "docker $*" >> "${root}/docker.log"\n`);
  await chmod(join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { root, repo };
}

const issueState = (root: string, n: number, state: string) => Bun.write(join(root, `issue-${n}.json`), JSON.stringify({ state }));
const prState = (root: string, branch: string, state: string) => Bun.write(join(root, `pr-${branch.replace("/", "_")}.json`), JSON.stringify([{ state }]));
const branches = async (repo: string) => (await $`git -C ${repo} for-each-ref ${"--format=%(refname:short)"} refs/heads`.text()).trim().split("\n");
const tags = async (repo: string) => (await $`git -C ${repo} tag --list ${"bunker/stale/*"}`.text()).trim().split("\n").filter(Boolean);
const commit = async (dir: string, file: string) => {
  await Bun.write(join(dir, file), "x\n");
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m ${file}`;
};

/** A `/tmp/bunker-<id>` worktree on `bunker/<id>`, like an interrupted run leaves. */
async function leftover(repo: string, id: string) {
  const path = join(tmpdir(), `bunker-${id}`);
  extraDirs.push(path);
  await $`git -C ${repo} worktree add -q -b bunker/${id} ${path} main`;
  return path;
}

async function issueWorktree(repo: string, n: number, slug: string, kind = "feature") {
  const path = join(repo, ".worktrees", `${n}-${slug}`);
  await $`git -C ${repo} worktree add -q -b ${kind}/${n}-${slug} ${path} main`;
  return path;
}

const run = (repo: string, o: Partial<Parameters<typeof runClean>[0]> = {}) => {
  const lines: string[] = [];
  return runClean({ cwd: repo, log: (s) => lines.push(s), ...o }).then((r) => ({ ...r, out: lines.join("\n") }));
};

describe("bunker clean", () => {
  test("dry run lists everything and removes nothing", async () => {
    const { root, repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    const w = await issueWorktree(repo, 7, "merged-thing");
    await issueState(root, 7, "CLOSED");
    await $`git -C ${repo} branch bunker/bbbb0002`;
    await $`git -C ${repo} branch feature/9-empty`;
    const r = await run(repo);
    expect(r.code).toBe(0);
    for (const s of [a, w, "bunker/bbbb0002", "feature/9-empty"]) expect(r.out).toContain(s);
    expect(r.out).toContain("--yes");
    expect(existsSync(a)).toBe(true);
    expect(existsSync(w)).toBe(true);
    expect(await branches(repo)).toEqual(expect.arrayContaining(["bunker/aaaa0001", "bunker/bbbb0002", "feature/9-empty", "feature/7-merged-thing"]));
    expect(await tags(repo)).toEqual([]);
  });

  test("--yes removes merged/closed/empty leftovers and keeps what is in progress", async () => {
    const { root, repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    const closed = await issueWorktree(repo, 7, "closed");
    const merged = await issueWorktree(repo, 8, "merged", "fix");
    const open = await issueWorktree(repo, 10, "open");
    await issueState(root, 7, "CLOSED");
    await issueState(root, 8, "OPEN");
    await issueState(root, 10, "OPEN");
    await prState(root, "fix/8-merged", "MERGED");
    await $`git -C ${repo} branch bunker/bbbb0002`;
    await $`git -C ${repo} branch feature/9-empty`;
    const r = await run(repo, { yes: true });
    expect(r.code).toBe(0);
    for (const p of [a, closed, merged]) expect(existsSync(p)).toBe(false);
    expect(existsSync(open)).toBe(true);
    expect((await branches(repo)).sort()).toEqual(["feature/10-open", "main"]);
    expect(await tags(repo)).toEqual([]);
    expect(await $`git -C ${repo} worktree list --porcelain`.text()).not.toContain("aaaa0001");
  });

  test("a leftover with a unique commit is tagged, then removed", async () => {
    const { repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    await commit(a, "work.txt");
    const sha = (await $`git -C ${a} rev-parse HEAD`.text()).trim();
    const r = await run(repo, { yes: true });
    expect(existsSync(a)).toBe(false);
    expect(await branches(repo)).toEqual(["main"]);
    const t = await tags(repo);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatch(/^bunker\/stale\/bunker-aaaa0001-\d{8}T\d{6}Z$/);
    expect((await $`git -C ${repo} rev-parse ${t[0]!}`.text()).trim()).toBe(sha);
    expect(r.out).toContain(t[0]!);
  });

  test("uncommitted changes are preserved in the tag", async () => {
    const { repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    await Bun.write(join(a, "scratch.txt"), "precious\n");
    await commit(a, "base.txt");
    await Bun.write(join(a, "base.txt"), "edited\n");
    await Bun.write(join(a, "new.txt"), "untracked\n");
    await run(repo, { yes: true });
    expect(existsSync(a)).toBe(false);
    const [t] = await tags(repo);
    expect(await $`git -C ${repo} show ${t + ":scratch.txt"}`.text()).toBe("precious\n");
    expect(await $`git -C ${repo} show ${t + ":base.txt"}`.text()).toBe("edited\n");
    expect(await $`git -C ${repo} show ${t + ":new.txt"}`.text()).toBe("untracked\n");
  });

  test("a stale-commit worktree without a branch name is tagged too, and a dirty empty one", async () => {
    const { repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    await Bun.write(join(a, "only-dirty.txt"), "d\n");
    await run(repo, { yes: true });
    const [t] = await tags(repo);
    expect(await $`git -C ${repo} show ${t + ":only-dirty.txt"}`.text()).toBe("d\n");
  });

  test("a branch with unique commits whose PR is closed is tagged, then deleted", async () => {
    const { root, repo } = await setup();
    await $`git -C ${repo} checkout -q -b fix/5-gone`;
    await commit(repo, "gone.txt");
    await $`git -C ${repo} checkout -q main`;
    await prState(root, "fix/5-gone", "CLOSED");
    await run(repo, { yes: true });
    expect(await branches(repo)).toEqual(["main"]);
    const [t] = await tags(repo);
    expect(t).toStartWith("bunker/stale/fix-5-gone-");
    expect(await $`git -C ${repo} show ${t + ":gone.txt"}`.text()).toBe("x\n");
  });

  test("an issue branch with an open PR and commits is kept", async () => {
    const { root, repo } = await setup();
    await $`git -C ${repo} checkout -q -b feature/6-live`;
    await commit(repo, "live.txt");
    await $`git -C ${repo} checkout -q main`;
    await prState(root, "feature/6-live", "OPEN");
    await run(repo, { yes: true });
    expect(await branches(repo)).toContain("feature/6-live");
    expect(await tags(repo)).toEqual([]);
  });

  test("never touches non-bunker branches, tags or worktrees", async () => {
    const { root, repo } = await setup();
    await $`git -C ${repo} branch topic/empty`;
    await $`git -C ${repo} branch feature/no-number`;
    await $`git -C ${repo} branch bunker/stale-ish`;
    await $`git -C ${repo} branch bunker/stale/x`;
    await $`git -C ${repo} tag v1`;
    const other = join(root, "other-wt");
    await $`git -C ${repo} worktree add -q -b wip/other ${other} main`;
    await run(repo, { yes: true, images: true });
    expect((await branches(repo)).sort()).toEqual(["bunker/stale-ish", "bunker/stale/x", "feature/no-number", "main", "topic/empty", "wip/other"]);
    expect(existsSync(other)).toBe(true);
    expect((await $`git -C ${repo} tag --list v1`.text()).trim()).toBe("v1");
  });

  test("refuses with exit 2 while a live watch lock exists, unless --force", async () => {
    const { repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    await mkdir(join(repo, ".bunker"), { recursive: true });
    const sleeper = Bun.spawn(["sleep", "30"]);
    try {
      await Bun.write(join(repo, ".bunker/watch.lock"), String(sleeper.pid));
      const r = await run(repo, { yes: true });
      expect(r.code).toBe(2);
      expect(r.out).toContain("--watch");
      expect(existsSync(a)).toBe(true);
      const f = await run(repo, { yes: true, force: true });
      expect(f.code).toBe(0);
      expect(existsSync(a)).toBe(false);
    } finally {
      sleeper.kill();
    }
  });

  test("a stale watch lock does not block", async () => {
    const { repo } = await setup();
    await mkdir(join(repo, ".bunker"), { recursive: true });
    await Bun.write(join(repo, ".bunker/watch.lock"), "999999999");
    expect((await run(repo)).code).toBe(0);
  });

  test("skips a /tmp worktree a running process is using", async () => {
    const { repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    const p = Bun.spawn(["sleep", "30"], { cwd: a });
    try {
      const r = await run(repo, { yes: true });
      expect(existsSync(a)).toBe(true);
      expect(r.out).toContain("in use");
    } finally {
      p.kill();
    }
  });

  test("skips an issue worktree a running process is using", async () => {
    const { repo } = await setup();
    const w = await issueWorktree(repo, 7, "closed");
    const p = Bun.spawn(["sleep", "30"], { cwd: w });
    try {
      const r = await run(repo, { yes: true });
      expect(existsSync(w)).toBe(true);
      expect(r.out).toContain("in use");
    } finally {
      p.kill();
    }
  });

  test("keeps the worktree and branch of a run paused on the usage limit", async () => {
    const { repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    await mkdir(join(repo, ".bunker/paused"), { recursive: true });
    await Bun.write(join(repo, ".bunker/paused/1.json"), JSON.stringify({ worktree: a, branch: "bunker/aaaa0001" }));
    await run(repo, { yes: true });
    expect(existsSync(a)).toBe(true);
    expect(await branches(repo)).toContain("bunker/aaaa0001");
  });

  test("refuses outside the main checkout", async () => {
    const { repo } = await setup();
    const w = await issueWorktree(repo, 3, "x");
    expect((await run(w)).code).toBe(2);
  });

  test("--logs removes only old run logs", async () => {
    const { repo } = await setup();
    const runs = join(repo, ".bunker/runs");
    await mkdir(runs, { recursive: true });
    await Bun.write(join(runs, "1-old.log"), "x");
    await Bun.write(join(runs, "2-new.log"), "x");
    const old = new Date(Date.now() - 10 * 86_400_000);
    await utimes(join(runs, "1-old.log"), old, old);
    const dry = await run(repo, { logsDays: 5 });
    expect(dry.out).toContain("1-old.log");
    expect(existsSync(join(runs, "1-old.log"))).toBe(true);
    await run(repo, { yes: true, logsDays: 5 });
    expect(existsSync(join(runs, "1-old.log"))).toBe(false);
    expect(existsSync(join(runs, "2-new.log"))).toBe(true);
    await run(repo, { yes: true });
    expect(existsSync(join(runs, "2-new.log"))).toBe(true);
  });

  describe("sessions and auto log pruning", () => {
    const session = async (repo: string, n: number) => {
      await Bun.write(join(repo, ".bunker/sessions", String(n), "s.jsonl"), "x");
      return join(repo, ".bunker/sessions", String(n));
    };

    test("removes the sessions of closed issues, keeps open ones and failed lookups", async () => {
      const { root, repo } = await setup();
      await issueState(root, 1, "CLOSED");
      await issueState(root, 2, "OPEN");
      const [s1, s2, s3] = [await session(repo, 1), await session(repo, 2), await session(repo, 3)]; // 3: gh fails
      const dry = await run(repo);
      expect(dry.out).toContain("sessions/1");
      expect(existsSync(s1)).toBe(true);
      await run(repo, { yes: true });
      expect(existsSync(s1)).toBe(false);
      expect(existsSync(s2)).toBe(true);
      expect(existsSync(s3)).toBe(true);
    });

    test("keeps the session and log of a paused issue even if it is closed", async () => {
      const { root, repo } = await setup();
      await issueState(root, 1, "CLOSED");
      const s1 = await session(repo, 1);
      await Bun.write(join(repo, ".bunker/paused/1.json"), "{}");
      const log = join(repo, ".bunker/runs/1-old.log");
      await Bun.write(log, "x");
      const old = new Date(Date.now() - 90 * 86_400_000);
      await utimes(log, old, old);
      await run(repo, { yes: true, auto: true, logsDays: 30 });
      expect(existsSync(s1)).toBe(true);
      expect(existsSync(log)).toBe(true);
    });

    test("start-up (auto) cleanup prunes old logs and closed sessions", async () => {
      const { root, repo } = await setup();
      await issueState(root, 1, "CLOSED");
      const s1 = await session(repo, 1);
      const runs = join(repo, ".bunker/runs");
      await Bun.write(join(runs, "9-old.log"), "x");
      await Bun.write(join(runs, "9-new.log"), "x");
      const old = new Date(Date.now() - 40 * 86_400_000);
      await utimes(join(runs, "9-old.log"), old, old);
      await run(repo, { yes: true, auto: true, logsDays: 30 });
      expect(existsSync(s1)).toBe(false);
      expect(existsSync(join(runs, "9-old.log"))).toBe(false);
      expect(existsSync(join(runs, "9-new.log"))).toBe(true);
    });

    test("keeps the session of an issue whose worktree a process is using", async () => {
      const { root, repo } = await setup();
      await issueState(root, 4, "CLOSED");
      const s4 = await session(repo, 4);
      const w = await issueWorktree(repo, 4, "busy");
      const p = Bun.spawn(["sleep", "30"], { cwd: w });
      try {
        await run(repo, { yes: true });
        expect(existsSync(s4)).toBe(true);
      } finally {
        p.kill();
      }
    });
  });

  test("tests never reach the real docker daemon: the default fake docker answers --images", async () => {
    const { root, repo } = await setup();
    await run(repo, { yes: true, images: true });
    const log = await Bun.file(join(root, "docker.log")).text();
    expect(log).toContain("docker images");
    expect(log).not.toContain("rmi");
  });

  test("--images removes unused bunker-repo-* images only", async () => {
    const { root, repo } = await setup();
    await Bun.write(
      join(root, "bin/docker"),
      `#!/bin/sh
echo "docker $*" >> "${root}/docker.log"
case "$1" in
  images) printf 'bunker-claude:latest\\nbunker-repo-a-1:latest\\nbunker-repo-b-2:latest\\nother:latest\\n';;
  ps) echo bunker-repo-b-2;;
esac
`,
    );
    await chmod(join(root, "bin/docker"), 0o755);
    const dry = await run(repo, { images: true });
    expect(dry.out).toContain("bunker-repo-a-1");
    expect(await Bun.file(join(root, "docker.log")).text()).not.toContain("rmi");
    await run(repo, { yes: true, images: true });
    const log = await Bun.file(join(root, "docker.log")).text();
    expect(log).toContain("rmi bunker-repo-a-1:latest");
    expect(log).not.toContain("rmi bunker-repo-b-2");
    expect(log).not.toContain("rmi bunker-claude");
    expect(log).not.toContain("rmi other");
  });

  test("auto mode is quiet when there is nothing to do and skips under a live watch lock", async () => {
    const { repo } = await setup();
    const a = await leftover(repo, "aaaa0001");
    const sleeper = Bun.spawn(["sleep", "30"]);
    try {
      await mkdir(join(repo, ".bunker"), { recursive: true });
      await Bun.write(join(repo, ".bunker/watch.lock"), String(sleeper.pid));
      const r = await run(repo, { yes: true, auto: true });
      expect(r.code).toBe(0);
      expect(existsSync(a)).toBe(true);
    } finally {
      sleeper.kill();
    }
    expect(realpathSync(repo)).toBeTruthy();
  });
});

describe("Ctrl-C / SIGTERM", () => {
  const script = (repo: string, commitFirst: boolean, marker: string) => `
import { run, noSandbox } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};
const agent = { command: () => ["sh", "-c", ${JSON.stringify(commitFirst ? `echo a > a.txt && git add . && git commit -qm a; touch ${marker}; sleep 30` : `touch ${marker}; sleep 30`)}] };
run({ cwd: ${JSON.stringify(repo)}, prompt: "x", agent, sandbox: noSandbox() }).catch(() => {});
`;
  for (const [commitFirst, name] of [[false, "removes the run's empty worktree and branch"], [true, "keeps a run that has commits"]] as const) {
    test(name, async () => {
      const { root, repo } = await setup();
      const file = join(root, "run.ts");
      await Bun.write(file, script(repo, commitFirst, join(root, "started")));
      const p = Bun.spawn(["bun", file], { stdout: "ignore", stderr: "ignore" });
      const wait = async (cond: () => Promise<boolean>) => {
        for (let i = 0; i < 200 && !(await cond()); i++) await Bun.sleep(50);
      };
      const bunkerBranches = async () => (await branches(repo)).filter((b) => b.startsWith("bunker/"));
      await wait(async () => existsSync(join(root, "started")));
      p.kill("SIGTERM");
      await p.exited;
      if (commitFirst) {
        expect(await bunkerBranches()).toHaveLength(1);
        const [b] = await bunkerBranches();
        await $`git -C ${repo} worktree remove --force ${join(tmpdir(), "bunker-" + b!.slice(7))}`.nothrow().quiet();
      } else {
        expect(await bunkerBranches()).toEqual([]);
        expect(await $`git -C ${repo} worktree list`.text()).not.toMatch(/\/bunker-[0-9a-f]{8} /);
      }
    });
  }
});
