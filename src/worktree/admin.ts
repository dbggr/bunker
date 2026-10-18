import { $ } from "bun";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoConfig } from "../core/config.ts";
import { stepLimits, type Sandbox, type Timeouts } from "../sandboxes/exec.ts";
import { copyIntoWorktree } from "./copy.ts";

export interface Worktree {
  branch: string;
  path: string;
}

export async function repoInfo(cwd: string) {
  const base = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim();
  const gitCommonDir = (await $`git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  return { base, gitCommonDir };
}

/**
 * Runs the setup step in `worktree`, inside `sandbox`: `setup` if given, else the repo's
 * `.bunker/setup` script if present. Returns undefined when there is no setup, else the command result.
 * Rejects with ConfigError if `.bunker/config.toml` is invalid.
 */
export async function runSetup(
  sandbox: Sandbox,
  ctx: { worktree: string; gitCommonDir: string },
  setup?: string,
  timeouts: Timeouts = {},
): Promise<{ cmd: string; code: number; stdout: string; timedOut?: "idle" | "step" } | undefined> {
  const cmd = setup ?? (await loadRepoConfig(ctx.worktree).then((c) => c.config.setup ?? c.legacy.setup));
  if (!cmd) return undefined;
  const out = await sandbox.exec(["sh", "-c", `(${cmd}) 2>&1`], { ...ctx, limits: stepLimits(timeouts) });
  return { cmd, ...out };
}

let worktreeAdminTail: Promise<unknown> = Promise.resolve();

/** Path of the lock file that serializes worktree admin commands across bunker processes on `repo`. */
export async function worktreeAdminLockPath(repo: string): Promise<string> {
  const common = (await $`git -C ${repo} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  return join(common, "bunker-worktree-admin.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireWorktreeLock(lock: string): Promise<void> {
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = Number.parseInt(await Bun.file(lock).text().catch(() => ""), 10);
    // An unreadable or half-written lock is left alone; only a dead owner's lock is taken over.
    if (Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) rmSync(lock, { force: true });
    else await Bun.sleep(50);
  }
}

/**
 * Runs `fn` (git worktree add/remove, branch -D) after earlier such commands on `repo`, in this process and in any other
 * bunker process (a lock file under the git common dir). They read every worktree's admin dir under .git/worktrees, so
 * one running beside a `worktree add` can read it half-written and fail ("failed to read .../commondir").
 */
export function worktreeAdmin<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const run = worktreeAdminTail.then(async () => {
    const lock = await worktreeAdminLockPath(repo);
    await acquireWorktreeLock(lock);
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  });
  worktreeAdminTail = run.catch(() => {});
  return run;
}

/** This process's `/tmp/bunker-*` worktrees that are still live, by path. */
export const tmpWorktrees = new Map<string, { repo: string; base: string; branch: string }>();
let tmpHooked = false;

/** Remove each live /tmp worktree and its branch if it has no commits and no changes. Synchronous: runs in exit and signal handlers. */
function cleanupTmpWorktrees(): void {
  for (const [path, w] of tmpWorktrees) {
    const commits = Bun.spawnSync(["git", "-C", w.repo, "rev-list", "--count", `${w.base}..${w.branch}`]);
    if (commits.exitCode !== 0 || commits.stdout.toString().trim() !== "0") continue;
    if (existsSync(path)) {
      const dirty = Bun.spawnSync(["git", "-C", path, "status", "--porcelain"]);
      if (dirty.exitCode !== 0 || dirty.stdout.toString().trim()) continue;
      Bun.spawnSync(["git", "-C", w.repo, "worktree", "remove", "--force", path]);
    }
    Bun.spawnSync(["git", "-C", w.repo, "worktree", "prune"]);
    Bun.spawnSync(["git", "-C", w.repo, "branch", "-D", w.branch]);
    tmpWorktrees.delete(path);
  }
}

export async function addWorktree(cwd: string, base: string): Promise<Worktree> {
  const id = crypto.randomUUID().slice(0, 8);
  const wt = { branch: `bunker/${id}`, path: join(tmpdir(), `bunker-${id}`) };
  await worktreeAdmin(cwd, () => $`git -C ${cwd} worktree add -q -b ${wt.branch} ${wt.path} ${base}`);
  tmpWorktrees.set(wt.path, { repo: cwd, base, branch: wt.branch });
  if (!tmpHooked) {
    tmpHooked = true;
    process.on("exit", cleanupTmpWorktrees);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      // The watch CLI installs its own handler (which exits through the "exit" hook above).
      if (process.listenerCount(sig) === 0) process.on(sig, () => process.exit(130));
    }
  }
  return wt;
}

/** Copies the patterns (default: .bunker/copy) into the fresh worktree; on failure removes the worktree and branch. */
export async function copyInto(cwd: string, wt: Worktree, patterns: string[]): Promise<string[]> {
  try {
    return await copyIntoWorktree(cwd, wt.path, patterns);
  } catch (e) {
    await worktreeAdmin(cwd, () => $`git -C ${cwd} worktree remove --force ${wt.path}`.nothrow().quiet());
    await worktreeAdmin(cwd, () => $`git -C ${cwd} branch -D ${wt.branch}`.nothrow().quiet());
    throw e;
  }
}
