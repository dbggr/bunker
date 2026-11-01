import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasRunTrailer, stampCommits } from "../src/worktree/trailer.ts";

setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))));

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "bunker-trailer-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir} && git -C ${dir} config user.name T && git -C ${dir} config user.email t@example.com`;
  await Bun.write(join(dir, "a"), "1\n");
  await $`git -C ${dir} add . && git -C ${dir} commit -q -m base`;
  return dir;
}
const msgs = async (dir: string, range: string) => (await $`git -C ${dir} log --format=%B%x00 ${range}`.text()).split("\0").map((m) => m.trim()).filter(Boolean);

test("stamps every commit in the range, keeping trees, authors and merges", async () => {
  const dir = await repo();
  await $`git -C ${dir} checkout -q -b feature/1-x`;
  await Bun.write(join(dir, "b"), "b\n");
  await $`git -C ${dir} add . && git -C ${dir} commit -q -m ${"feat: b\n\nbody"} --author="Someone <s@example.com>"`;
  await $`git -C ${dir} checkout -q main`;
  await Bun.write(join(dir, "c"), "c\n");
  await $`git -C ${dir} add . && git -C ${dir} commit -q -m upstream`;
  const upstream = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  await $`git -C ${dir} checkout -q feature/1-x && git -C ${dir} merge -q --no-edit main`;
  const before = (await $`git -C ${dir} rev-parse HEAD^{tree}`.text()).trim();

  const tip = await stampCommits(dir, "HEAD", [upstream], "1-2026-11-01T00-00-00-000Z");
  const log = await msgs(dir, `${upstream}..${tip}`);
  expect(log).toHaveLength(2); // the feature commit and the merge; upstream's commit is untouched
  for (const m of log) expect(m).toContain("Bunker-Run: 1-2026-11-01T00-00-00-000Z");
  expect(log.every(hasRunTrailer)).toBe(true);
  expect((await $`git -C ${dir} rev-parse ${tip}^{tree}`.text()).trim()).toBe(before);
  expect((await $`git -C ${dir} log -1 --format=%an ${tip}^2~0`.nothrow().text()).trim()).toBeDefined();
  expect((await $`git -C ${dir} log --format=%an ${upstream}..${tip}`.text()).includes("Someone")).toBe(true);
  expect((await $`git -C ${dir} rev-list --parents -n1 ${tip}`.text()).trim().split(" ")).toContain(upstream);
});

test("is idempotent and leaves nothing to do for an empty range", async () => {
  const dir = await repo();
  const base = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  expect(await stampCommits(dir, "HEAD", [base], "1-x")).toBe(base);
  await Bun.write(join(dir, "b"), "b\n");
  await $`git -C ${dir} add . && git -C ${dir} commit -q -m b`;
  const once = await stampCommits(dir, "HEAD", [base], "1-x");
  expect(await stampCommits(dir, once, [base], "1-x")).toBe(once);
});

test("hasRunTrailer only matches the trailer block", () => {
  expect(hasRunTrailer("fix: x\n\nBunker-Run: 5-2026")).toBe(true);
  expect(hasRunTrailer("Merge branch 'main' into x")).toBe(false);
  expect(hasRunTrailer("fix: x\n\nmentions Bunker-Run: 5 in prose\n\nmore text")).toBe(false);
});
