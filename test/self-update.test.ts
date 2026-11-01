import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestTag, selfUpdate } from "../src/cli/commands/self-update.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture(tags: string[]) {
  const root = await mkdtemp(join(tmpdir(), "bunker-su-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} remote add origin ${origin}`;
  const commit = async (n: string) => {
    await Bun.write(join(repo, "marker.txt"), `${n}\n`);
    await $`git -C ${repo} add . && git -C ${repo} commit -q -m ${n}`;
  };
  for (const t of tags) {
    await commit(t);
    await $`git -C ${repo} tag ${t}`;
  }
  await commit("main-tip");
  await $`git -C ${repo} push -q -u origin main --tags`;
  return { repo, root };
}

/** A fake build: records the marker file of the tree it was asked to build, and the BUNKER_HOME it is for. */
const fakeBuild = (seen: string[]) => async (dir: string, home: string) => {
  seen.push((await Bun.file(join(dir, "marker.txt")).text()).trim());
  const bin = join(dir, "fake-bunker");
  await Bun.write(bin, "bin");
  return bin;
};

describe("latestTag", () => {
  test("picks the highest semver, not the lexically last or newest", async () => {
    const f = await fixture(["v1.2.0", "v1.10.0", "v1.9.9"]);
    expect(await latestTag(f.repo)).toBe("v1.10.0");
  });

  test("ignores non-v tags and prereleases", async () => {
    const f = await fixture(["v1.0.0", "nightly", "v9", "2.0.0", "v3.0.0-rc1", "release-5.0.0"]);
    expect(await latestTag(f.repo)).toBe("v1.0.0");
  });

  test("undefined without release tags", async () => {
    const f = await fixture(["nightly"]);
    expect(await latestTag(f.repo)).toBeUndefined();
  });
});

describe("selfUpdate", () => {
  test("default channel builds and installs the highest v tag, not main", async () => {
    const f = await fixture(["v1.0.0", "v1.1.0", "junk"]);
    const seen: string[] = [];
    const target = join(f.root, "bin", "bunker");
    const code = await selfUpdate({ home: f.repo, target, build: fakeBuild(seen) });
    expect(code).toBe(0);
    expect(seen).toEqual(["v1.1.0"]);
    expect(await Bun.file(target).text()).toBe("bin");
    expect((await $`git -C ${f.repo} worktree list`.text()).trim().split("\n")).toHaveLength(1);
  });

  test("fetches tags pushed to origin since the last fetch", async () => {
    const f = await fixture(["v1.0.0"]);
    const other = join(f.root, "other");
    await $`git clone -q ${join(f.root, "origin.git")} ${other}`.quiet();
    await Bun.write(join(other, "marker.txt"), "rel\n");
    await $`git -C ${other} add . && git -C ${other} -c user.name=T -c user.email=t@e.com commit -q -m rel`;
    await $`git -C ${other} tag v2.0.0 && git -C ${other} push -q origin v2.0.0`;
    const seen: string[] = [];
    expect(await selfUpdate({ home: f.repo, target: join(f.root, "b"), build: fakeBuild(seen) })).toBe(0);
    expect(seen).toEqual(["rel"]);
  });

  test("works on a dirty checkout or another branch (the checkout is untouched)", async () => {
    const f = await fixture(["v1.0.0"]);
    await $`git -C ${f.repo} checkout -q -b feature`;
    await Bun.write(join(f.repo, "marker.txt"), "dirty\n");
    const seen: string[] = [];
    expect(await selfUpdate({ home: f.repo, target: join(f.root, "b"), build: fakeBuild(seen) })).toBe(0);
    expect(await Bun.file(join(f.repo, "marker.txt")).text()).toBe("dirty\n");
  });

  test("no release tags: exit 2, nothing built", async () => {
    const f = await fixture(["nightly"]);
    const seen: string[] = [];
    const target = join(f.root, "b");
    expect(await selfUpdate({ home: f.repo, target, build: fakeBuild(seen) })).toBe(2);
    expect(seen).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  test("--channel main pulls and builds main, ignoring tags", async () => {
    const f = await fixture(["v1.0.0"]);
    const seen: string[] = [];
    const target = join(f.root, "b");
    expect(await selfUpdate({ home: f.repo, channel: "main", target, build: fakeBuild(seen) })).toBe(0);
    expect(seen).toEqual(["main-tip"]);
    expect(existsSync(target)).toBe(true);
  });

  test("--channel main still refuses a dirty checkout", async () => {
    const f = await fixture(["v1.0.0"]);
    await Bun.write(join(f.repo, "marker.txt"), "dirty\n");
    expect(await selfUpdate({ home: f.repo, channel: "main", build: fakeBuild([]) })).toBe(2);
  });

  test("unknown channel exits 2", async () => {
    const f = await fixture(["v1.0.0"]);
    expect(await selfUpdate({ home: f.repo, channel: "beta", build: fakeBuild([]) })).toBe(2);
  });
});

describe("selfUpdate --when-idle", () => {
  /** A fake lock file as a running watch leaves it (the test process is alive). */
  const lock = async (repo: string) => {
    await Bun.write(join(repo, ".bunker", "watch.lock"), String(process.pid));
  };
  const control = (log: string[], units: string[] = []) => ({
    units: async () => units,
    stop: async (pid: number) => {
      log.push(`stop ${pid}`);
      return true;
    },
    restartUnit: async (repo: string) => {
      log.push(`restart ${repo}`);
      return true;
    },
  });

  test("without the flag, the refusal names --when-idle", async () => {
    const f = await fixture(["v1.0.0"]);
    await lock(f.repo);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      expect(await selfUpdate({ home: f.repo, build: fakeBuild([]) })).toBe(2);
    } finally {
      console.error = orig;
    }
    expect(errs.join("\n")).toContain("--when-idle");
  });

  test("drains the watch, updates, then restarts the unit it stopped", async () => {
    const f = await fixture(["v1.0.0"]);
    await lock(f.repo);
    const log: string[] = [];
    const c = control(log, [f.repo]);
    const build = async (dir: string, home: string) => {
      log.push("build");
      return fakeBuild([])(dir, home);
    };
    const code = await selfUpdate({ home: f.repo, target: join(f.root, "b"), build, whenIdle: true, watches: c });
    expect(code).toBe(0);
    expect(log).toEqual([`stop ${process.pid}`, "build", `restart ${f.repo}`]);
  });

  test("a watch outside systemd is drained and updated but left for the user to restart", async () => {
    const f = await fixture(["v1.0.0"]);
    await lock(f.repo);
    const log: string[] = [];
    expect(await selfUpdate({ home: f.repo, target: join(f.root, "b"), build: fakeBuild([]), whenIdle: true, watches: control(log) })).toBe(0);
    expect(log).toEqual([`stop ${process.pid}`]);
  });

  test("--restart-all drains and restarts every active unit", async () => {
    const f = await fixture(["v1.0.0"]);
    const other = await fixture(["v1.0.0"]);
    await lock(other.repo);
    const log: string[] = [];
    const code = await selfUpdate({ home: f.repo, target: join(f.root, "b"), build: fakeBuild([]), whenIdle: true, restartAll: true, watches: control(log, [other.repo]) });
    expect(code).toBe(0);
    expect(log).toEqual([`stop ${process.pid}`, `restart ${other.repo}`]);
  });

  test("a drain that fails aborts before building", async () => {
    const f = await fixture(["v1.0.0"]);
    await lock(f.repo);
    const seen: string[] = [];
    const c = { ...control([]), stop: async () => false };
    expect(await selfUpdate({ home: f.repo, target: join(f.root, "b"), build: fakeBuild(seen), whenIdle: true, watches: c })).toBe(1);
    expect(seen).toEqual([]);
  });

  test("a failed update still restarts the watches it stopped", async () => {
    const f = await fixture(["v1.0.0"]);
    await lock(f.repo);
    const log: string[] = [];
    const code = await selfUpdate({ home: f.repo, target: join(f.root, "b"), build: async () => undefined, whenIdle: true, watches: control(log, [f.repo]) });
    expect(code).toBe(1);
    expect(log).toEqual([`stop ${process.pid}`, `restart ${f.repo}`]);
  });
});
