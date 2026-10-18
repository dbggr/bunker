import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePull } from "../src/github/pull.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const CLI = join(import.meta.dir, "..", "src/cli.ts");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bunker-pull-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const other = join(root, "other");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await Bun.write(join(repo, "a.txt"), "a\n");
  await $`git -C ${repo} add . && git -C ${repo} commit -q -m init && git -C ${repo} push -q -u origin main`;
  await $`git clone -q ${origin} ${other}`.quiet();
  await $`git -C ${other} config user.name Test`;
  await $`git -C ${other} config user.email test@example.com`;
  const advance = async (file = "b.txt") => {
    await Bun.write(join(other, file), "x\n");
    await $`git -C ${other} add . && git -C ${other} commit -q -m more && git -C ${other} push -q origin main`;
  };
  const head = async () => (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  return { repo, advance, head };
}

describe("safePull", () => {
  test("clean default branch is fast-forwarded", async () => {
    const f = await fixture();
    await f.advance();
    const before = await f.head();
    const r = await safePull(f.repo);
    expect(r.pulled).toBe(true);
    expect(await f.head()).not.toBe(before);
  });

  test("untracked files do not block the pull", async () => {
    const f = await fixture();
    await f.advance();
    await Bun.write(join(f.repo, "scratch.txt"), "x");
    expect((await safePull(f.repo)).pulled).toBe(true);
  });

  test("dirty tree: not pulled, says why", async () => {
    const f = await fixture();
    await f.advance();
    await Bun.write(join(f.repo, "a.txt"), "changed\n");
    const before = await f.head();
    const r = await safePull(f.repo);
    expect(r.pulled).toBe(false);
    expect(r.message).toMatch(/^bunker: not pulling — .*uncommitted/);
    expect(await f.head()).toBe(before);
  });

  test("other branch: not pulled", async () => {
    const f = await fixture();
    await $`git -C ${f.repo} checkout -q -b feature`;
    await f.advance();
    const before = await f.head();
    const r = await safePull(f.repo);
    expect(r.pulled).toBe(false);
    expect(r.message).toMatch(/^bunker: not pulling — .*feature/);
    expect(await f.head()).toBe(before);
  });

  test("diverged: warns and does not touch the checkout", async () => {
    const f = await fixture();
    await Bun.write(join(f.repo, "local.txt"), "l\n");
    await $`git -C ${f.repo} add . && git -C ${f.repo} commit -q -m local`;
    await f.advance();
    const before = await f.head();
    const r = await safePull(f.repo);
    expect(r.pulled).toBe(false);
    expect(r.message).toMatch(/^bunker: not pulling — /);
    expect(await f.head()).toBe(before);
  });
});

describe("cli", () => {
  const selfUpdate = (repo: string) => Bun.spawnSync(["bun", CLI, "self-update", "--channel", "main"], { cwd: repo, env: { ...process.env, BUNKER_HOME: repo } });

  test("--no-pull is documented in --help", () => {
    const p = Bun.spawnSync(["bun", CLI, "--help"]);
    expect(p.stdout.toString()).toContain("--no-pull");
  });

  test("--version prints the version and commit", () => {
    const p = Bun.spawnSync(["bun", CLI, "--version"]);
    expect(p.stdout.toString()).toMatch(/^\d+\.\d+\.\d+ \((v\d+\.\d+\.\d+|main@\w+)\)/);
  });

  // `--issue 0` fails validation right after the pull step, so nothing else (agent, gh, docker) runs.
  const runIssue0 = (repo: string, ...flags: string[]) =>
    Bun.spawnSync(["bun", CLI, "issue", "0", ...flags], { cwd: repo, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-test-token-0123456789" } });
  const CONTINUED = "issue number must be a positive integer";

  test("pulls by default, not with --no-pull", async () => {
    const f = await fixture();
    await f.advance();
    const before = await f.head();
    const skipped = runIssue0(f.repo, "--no-pull");
    expect(skipped.stderr.toString()).toContain(CONTINUED);
    expect(await f.head()).toBe(before);
    const pulled = runIssue0(f.repo);
    expect(pulled.stderr.toString()).toContain(CONTINUED);
    expect(await f.head()).not.toBe(before);
    expect(pulled.stdout.toString()).not.toContain("not pulling");
  });

  test("dirty tree: warns on stdout and the run continues", async () => {
    const f = await fixture();
    await f.advance();
    await Bun.write(join(f.repo, "a.txt"), "changed\n");
    const before = await f.head();
    const p = runIssue0(f.repo);
    expect(p.stdout.toString()).toMatch(/bunker: not pulling — .*uncommitted/);
    expect(p.stderr.toString()).toContain(CONTINUED);
    expect(await f.head()).toBe(before);
  });

  test("other branch: warns and the run continues", async () => {
    const f = await fixture();
    await $`git -C ${f.repo} checkout -q -b feature`;
    await f.advance();
    const p = runIssue0(f.repo);
    expect(p.stdout.toString()).toMatch(/bunker: not pulling — .*feature/);
    expect(p.stderr.toString()).toContain(CONTINUED);
  });

  test("diverged: warns and the run continues", async () => {
    const f = await fixture();
    await Bun.write(join(f.repo, "local.txt"), "l\n");
    await $`git -C ${f.repo} add . && git -C ${f.repo} commit -q -m local`;
    await f.advance();
    const before = await f.head();
    const p = runIssue0(f.repo);
    expect(p.stdout.toString()).toMatch(/bunker: not pulling — /);
    expect(p.stderr.toString()).toContain(CONTINUED);
    expect(await f.head()).toBe(before);
  });

  test("self-update on a dirty checkout exits 2", async () => {
    const f = await fixture();
    await Bun.write(join(f.repo, "a.txt"), "changed\n");
    const p = selfUpdate(f.repo);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toMatch(/uncommitted/);
  });

  test("self-update on a non-default branch exits 2", async () => {
    const f = await fixture();
    await $`git -C ${f.repo} checkout -q -b feature`;
    expect(selfUpdate(f.repo).exitCode).toBe(2);
  });

  test("self-update refuses while a --watch holds the lock", async () => {
    const f = await fixture();
    await $`mkdir -p ${f.repo}/.bunker`;
    await Bun.write(join(f.repo, ".bunker", "watch.lock"), String(process.pid));
    const p = selfUpdate(f.repo);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("watch");
  });
});
