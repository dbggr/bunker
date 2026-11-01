import { expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeAdmin, worktreeAdminLockPath } from "../src/worktree/admin.ts";
import { mergeBack } from "../src/worktree/merge.ts";

setDefaultTimeout(60_000); // see test/setup.ts

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bunker-wtadmin-"));
  await $`git -C ${dir} init -q`.quiet();
  return dir;
}

test("holds a lock file under the git common dir while fn runs, and removes it after", async () => {
  const dir = await repo();
  const lock = await worktreeAdminLockPath(dir);
  expect(lock.startsWith(join(dir, ".git"))).toBe(true);
  await worktreeAdmin(dir, async () => {
    expect(existsSync(lock)).toBe(true);
  });
  expect(existsSync(lock)).toBe(false);
});

test("releases the lock when fn throws", async () => {
  const dir = await repo();
  await expect(worktreeAdmin(dir, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(existsSync(await worktreeAdminLockPath(dir))).toBe(false);
});

test("waits for a lock held by another live process", async () => {
  const dir = await repo();
  const lock = await worktreeAdminLockPath(dir);
  const holder = Bun.spawn(["sleep", "30"]);
  try {
    writeFileSync(lock, String(holder.pid));
    let ran = false;
    const p = worktreeAdmin(dir, async () => { ran = true; });
    await Bun.sleep(400);
    expect(ran).toBe(false);
    holder.kill();
    await holder.exited;
    await p;
    expect(ran).toBe(true);
  } finally {
    holder.kill();
  }
});

test("takes over a lock whose owner is dead", async () => {
  const dir = await repo();
  const lock = await worktreeAdminLockPath(dir);
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  writeFileSync(lock, String(dead.pid));
  let ran = false;
  await worktreeAdmin(dir, async () => { ran = true; });
  expect(ran).toBe(true);
  expect(existsSync(lock)).toBe(false);
});

test("still serializes calls within one process", async () => {
  const dir = await repo();
  const order: string[] = [];
  await Promise.all([1, 2, 3].map((n) => worktreeAdmin(dir, async () => {
    order.push(`start${n}`);
    await Bun.sleep(20);
    order.push(`end${n}`);
  })));
  expect(order).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
});

test("mergeBack deletes the branch under the lock, waiting for a holder", async () => {
  const dir = await repo();
  await $`git -C ${dir} -c user.name=T -c user.email=t@e.com commit -q --allow-empty -m init`.quiet();
  await $`git -C ${dir} branch feature/x`.quiet();
  const lock = await worktreeAdminLockPath(dir);
  const holder = Bun.spawn(["sleep", "30"]);
  try {
    writeFileSync(lock, String(holder.pid));
    const p = mergeBack(dir, "feature/x", []);
    await Bun.sleep(400);
    expect((await $`git -C ${dir} branch --list feature/x`.text()).trim()).not.toBe("");
    holder.kill();
    await holder.exited;
    await p;
    expect((await $`git -C ${dir} branch --list feature/x`.text()).trim()).toBe("");
  } finally {
    holder.kill();
  }
});
