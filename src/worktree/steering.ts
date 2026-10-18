import { $ } from "bun";
import { rmdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Paths (at any depth) that steer an agent: `.claude/` (skills, settings, hooks, commands), `CLAUDE.md` and `AGENTS.md`. */
export const STEERING = /(^|\/)(\.claude\/|CLAUDE\.md$|AGENTS\.md$)/;

const listed = async (cmd: Promise<{ stdout: Buffer }>) => (await cmd).stdout.toString().split("\0").filter((f) => f && STEERING.test(f));

/**
 * Makes the steering files in `worktree` the ones at `base` (the default branch): the agent's are removed, base's checked out.
 * For the reviewer only; the caller resets the worktree to the agent's commit afterwards.
 */
export async function restoreSteering(worktree: string, base: string): Promise<void> {
  const mine = await listed($`git -C ${worktree} ls-files -z --cached --others --exclude-standard`.quiet());
  for (const f of mine) {
    await rm(join(worktree, f), { force: true });
    // Prune directories the removal emptied, so a planted .claude/ leaves no trace.
    for (let d = dirname(f); d !== "."; d = dirname(d)) if (!(await rmdir(join(worktree, d)).then(() => true, () => false))) break;
  }
  const theirs = await listed($`git -C ${worktree} ls-tree -r -z --name-only ${base}`.quiet());
  if (theirs.length) await $`git -C ${worktree} checkout ${base} -- ${theirs}`.quiet();
}
