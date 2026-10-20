import { $ } from "bun";
import { mkdtemp, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Paths (at any depth) that steer an agent: `.claude/` (skills, settings, hooks, commands), `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`. */
export const STEERING = /(^|\/)(\.claude\/|CLAUDE(\.local)?\.md$|AGENTS\.md$)/;

/** Paths only a human may merge changes to: `.bunker/` feeds the host, `.github/` is CI, and the steering files steer agents. */
export const isSensitivePath = (f: string) => /^\.(bunker|github)\//.test(f) || STEERING.test(f);

/** Files CI or verify executes (scripts, dependency locks, Makefiles), matched by name at any depth: effectively config, so only a human merges changes to them. */
export const DEFAULT_REVIEW_PATHS = ["package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.json", "composer.lock", "Makefile"];

/** Whether a human must review a change to `f`: a sensitive path, a default review path, or a match of one of the repo's `review_paths` globs. */
export const isReviewPath = (f: string, extra: readonly string[] = []): boolean =>
  isSensitivePath(f) || DEFAULT_REVIEW_PATHS.includes(f.slice(f.lastIndexOf("/") + 1)) || extra.some((g) => new Bun.Glob(g).match(f));

const listed = async (cmd: Promise<{ stdout: Buffer }>) => (await cmd).stdout.toString().split("\0").filter((f) => f && STEERING.test(f));

const prune = async (worktree: string, f: string) => {
  for (let d = dirname(f); d !== "."; d = dirname(d)) if (!(await rmdir(join(worktree, d)).then(() => true, () => false))) break;
};

/**
 * Makes the steering files in `worktree` the ones at `base` (the default branch): the agent's are removed, base's checked out.
 * Gitignored ones (e.g. `.claude/settings.local.json`) are moved aside, since `git clean` would not remove them and a reset would not restore them.
 * For the reviewer only. Afterwards the caller resets the worktree to the agent's commit and calls the returned function (idempotent)
 * to move the ignored files back.
 */
export async function restoreSteering(worktree: string, base: string): Promise<() => Promise<void>> {
  const tracked = await listed($`git -C ${worktree} ls-files -z --cached --others --exclude-standard`.quiet());
  const ignored = await listed($`git -C ${worktree} ls-files -z --others --ignored --exclude-standard`.quiet());
  for (const f of tracked) {
    await rm(join(worktree, f), { force: true });
    await prune(worktree, f); // a planted .claude/ leaves no trace
  }
  let aside: string | undefined;
  const moved: string[] = [];
  for (const f of ignored) {
    aside ??= await mkdtemp(join(tmpdir(), "bunker-steering-"));
    await mkdir(dirname(join(aside, f)), { recursive: true });
    await rename(join(worktree, f), join(aside, f));
    moved.push(f);
    await prune(worktree, f);
  }
  const theirs = await listed($`git -C ${worktree} ls-tree -r -z --name-only ${base}`.quiet());
  if (theirs.length) await $`git -C ${worktree} checkout ${base} -- ${theirs}`.quiet();
  return async () => {
    for (const f of moved.splice(0)) {
      await mkdir(dirname(join(worktree, f)), { recursive: true });
      await rm(join(worktree, f), { force: true });
      await rename(join(aside!, f), join(worktree, f));
    }
    if (aside) await rm(aside, { recursive: true, force: true });
  };
}
