import { $ } from "bun";

export interface PullResult {
  pulled: boolean;
  /** One line for the user: why nothing was pulled, or what was. */
  message: string;
}

/** Origin's default branch: asked of the remote, else the local origin/HEAD, else `main`. */
export async function defaultBranchOf(cwd: string): Promise<string> {
  const re = /^ref: refs\/heads\/(\S+)\s+HEAD$/m;
  const remote = await $`git -C ${cwd} ls-remote --symref origin HEAD`.nothrow().quiet();
  const fromRemote = re.exec(remote.stdout.toString())?.[1];
  if (fromRemote) return fromRemote;
  const local = await $`git -C ${cwd} symbolic-ref --short refs/remotes/origin/HEAD`.nothrow().quiet();
  return local.stdout.toString().trim().replace(/^origin\//, "") || "main";
}

/** Why `cwd` can't be fast-forwarded safely (tracked changes, or not on the default branch); undefined if it can. */
export async function pullBlocker(cwd: string): Promise<string | undefined> {
  const status = await $`git -C ${cwd} status --porcelain --untracked-files=no`.nothrow().quiet();
  if (status.exitCode !== 0) return "not a git checkout";
  if (status.stdout.toString().trim()) return "the working tree has uncommitted changes";
  const branch = (await $`git -C ${cwd} symbolic-ref --short -q HEAD`.nothrow().quiet().text()).trim();
  const def = await defaultBranchOf(cwd);
  if (branch !== def) return `on ${branch || "a detached HEAD"}, not the default branch (${def})`;
  return undefined;
}

/**
 * `git pull --ff-only` in the caller's checkout, only when it is clean and on the default branch.
 * Never stashes, merges, rebases or resets; any failure is reported, not thrown.
 */
export async function safePull(cwd: string): Promise<PullResult> {
  const blocker = await pullBlocker(cwd);
  if (blocker) return { pulled: false, message: `bunker: not pulling — ${blocker}` };
  const pull = await $`git -C ${cwd} pull --ff-only -q`.nothrow().quiet();
  if (pull.exitCode !== 0) {
    const why = pull.stderr.toString().trim().split("\n").filter(Boolean).slice(-2).join(" ") || `git pull exited ${pull.exitCode}`;
    return { pulled: false, message: `bunker: not pulling — ${why}` };
  }
  return { pulled: true, message: "bunker: pulled" };
}
