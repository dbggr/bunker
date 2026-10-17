import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Sandboxed agents write into the repo's git dir (objects, refs, their worktree's index),
 * but bunker then runs git on the host in the same repo. Hooks or config an agent plants
 * there would run outside the sandbox with the user's credentials. Three layers stop it:
 * the container mounts only what git needs writable (gitMountArgs), every sandbox step is
 * checked and rolled back if it touched hooks/config/pointers (guardGit), and host git
 * ignores hooks and fsmonitor regardless (hardenHostGit).
 */

const HOST_GIT_OVERRIDES: [string, string][] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
];

/** Makes every git bunker spawns (Bun `$` reads process.env live) ignore repo hooks and fsmonitor. Idempotent. */
export function hardenHostGit(env: Record<string, string | undefined> = process.env): void {
  let n = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isInteger(n) || n < 0) n = 0;
  const present = new Set(Array.from({ length: n }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]));
  for (const [key, value] of HOST_GIT_OVERRIDES) {
    if (present.has(key)) continue;
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
}

/** The worktree's admin dir (`<common>/worktrees/<id>`), from its `.git` file; undefined for a main checkout. */
export function gitAdminDir(worktree: string): string | undefined {
  const dotGit = join(worktree, ".git");
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return undefined;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!m) return undefined;
  const p = m[1]!.trim();
  return isAbsolute(p) ? p : resolve(worktree, p);
}

/**
 * Container mounts: the worktree read-write but its `.git` pointer read-only; the git common dir
 * read-only, with only `objects/`, `refs/`, `logs/` and this worktree's admin dir writable, and the
 * admin dir's `commondir`/`gitdir` pointers read-only again. Order matters: children after parents.
 */
export function gitMountArgs(worktree: string, gitCommonDir: string): string[] {
  const m = (src: string, ro = false) => ["-v", `${src}:${src}${ro ? ":ro" : ""}`];
  const args = [...m(worktree)];
  if (existsSync(join(worktree, ".git"))) args.push(...m(join(worktree, ".git"), true));
  args.push(...m(gitCommonDir, true));
  for (const sub of ["objects", "refs", "logs"]) {
    const p = join(gitCommonDir, sub);
    mkdirSync(p, { recursive: true });
    args.push(...m(p));
  }
  const admin = gitAdminDir(worktree);
  if (admin && existsSync(admin)) {
    args.push(...m(admin));
    for (const f of ["commondir", "gitdir"]) if (existsSync(join(admin, f))) args.push(...m(join(admin, f), true));
  }
  return args;
}

type Snapshot = Map<string, Buffer | null>;

/** The files whose change would let a sandbox step steer host git. */
function watchedPaths(worktree: string, gitCommonDir: string): string[] {
  const paths = [join(gitCommonDir, "config"), join(worktree, ".git")];
  const hooks = join(gitCommonDir, "hooks");
  if (existsSync(hooks)) for (const f of readdirSync(hooks)) paths.push(join(hooks, f));
  const admin = gitAdminDir(worktree);
  if (admin) for (const f of ["commondir", "gitdir", "config.worktree"]) paths.push(join(admin, f));
  return paths;
}

function snapshot(worktree: string, gitCommonDir: string): Snapshot {
  const s: Snapshot = new Map();
  for (const p of watchedPaths(worktree, gitCommonDir)) {
    try {
      s.set(p, statSync(p).isFile() ? readFileSync(p) : null);
    } catch {
      s.set(p, null);
    }
  }
  return s;
}

/** Config text without `[branch "…"]` entries: bunker's own `git push -u` writes those, and they can't run anything. */
async function configSansBranches(path: string, content: Buffer | null): Promise<string> {
  if (content === null) return "";
  const tmp = `${path}.bunker-guard-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  try {
    const r = await $`git config --file ${tmp} --list`.env({ ...process.env, GIT_CONFIG_COUNT: "0" }).nothrow().quiet();
    return r.exitCode === 0 ? r.stdout.toString().split("\n").filter((l) => !l.startsWith("branch.")).sort().join("\n") : content.toString();
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Paths that differ between the snapshot and now, including new hooks. */
async function changes(before: Snapshot, worktree: string, gitCommonDir: string): Promise<string[]> {
  const after = snapshot(worktree, gitCommonDir);
  const changed: string[] = [];
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(p) ?? null;
    const b = after.get(p) ?? null;
    if (a === null && b === null) continue;
    if (a !== null && b !== null && a.equals(b)) continue;
    if (p === join(gitCommonDir, "config") && (await configSansBranches(p, a)) === (await configSansBranches(p, b))) continue;
    changed.push(p);
  }
  return changed;
}

function restore(before: Snapshot, changed: string[]): void {
  for (const p of changed) {
    const content = before.get(p) ?? null;
    if (content === null) rmSync(p, { force: true, recursive: true });
    else writeFileSync(p, content);
  }
}

/**
 * Runs one sandbox step; if it changed the repo's git config, hooks or worktree pointers, puts them
 * back and fails the step, so nothing it planted can run when bunker next uses git on the host.
 */
export async function guardGit<T>(worktree: string, gitCommonDir: string, run: () => Promise<T>): Promise<T> {
  const before = snapshot(worktree, gitCommonDir);
  let result!: T;
  try {
    result = await run();
  } finally {
    const changed = await changes(before, worktree, gitCommonDir);
    if (changed.length) {
      restore(before, changed);
      // Thrown from finally so it wins over any error from the step itself.
      throw new Error(`agent modified git config or hooks: ${changed.join(", ")} (restored; the step is failed)`);
    }
  }
  return result;
}
