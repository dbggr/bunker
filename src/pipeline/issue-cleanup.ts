import { claimRemoteBranch, stamp, type LeftoverOpts } from "../github/branches.ts";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { emit } from "../core/events.ts";
import { worktreeAdmin } from "../worktree/admin.ts";

export interface Live { number: number; repo: string; worktree: string; branch: string; base: string }
const live = new Set<Live>();
let hooked = false;

/** Remove the worktree and branch of every run still in setup/implement that has committed nothing. Synchronous: safe in exit and signal handlers. */
export function cleanupInterrupted(): void {
  for (const l of live) {
    const commits = Bun.spawnSync(["git", "-C", l.repo, "rev-list", "--count", `${l.base}..${l.branch}`]);
    if (commits.exitCode === 0 && commits.stdout.toString().trim() !== "0") continue;
    const dirty = Bun.spawnSync(["git", "-C", l.worktree, "status", "--porcelain"]);
    if (dirty.exitCode === 0 && dirty.stdout.toString().trim()) continue;
    Bun.spawnSync(["git", "-C", l.repo, "worktree", "remove", "--force", l.worktree]);
    Bun.spawnSync(["git", "-C", l.repo, "worktree", "prune"]);
    Bun.spawnSync(["git", "-C", l.repo, "branch", "-D", l.branch]);
    live.delete(l);
  }
}

/**
 * A forced stop: keep what the interrupted runs of this issue did as a `bunker/stale/<n>-<timestamp>` tag (uncommitted changes are
 * committed first), then remove the worktree and branch. Returns the tag, if there was work to keep.
 */
export async function abandonLive(number: number): Promise<string | undefined> {
  let kept: string | undefined;
  for (const l of [...live].filter((x) => x.number === number)) {
    live.delete(l);
    const git = (...args: string[]) => $`git -C ${l.repo} ${args}`.nothrow().quiet();
    const commits = Number((await git("rev-list", "--count", `${l.base}..${l.branch}`)).stdout.toString().trim()) || 0;
    const dirty = existsSync(l.worktree) && (await $`git -C ${l.worktree} status --porcelain`.nothrow().quiet()).stdout.toString().trim() !== "";
    if (dirty) {
      await $`git -C ${l.worktree} add -A`.nothrow().quiet();
      await $`git -C ${l.worktree} -c user.name=bunker -c user.email=bunker@localhost commit -q -m ${"wip: uncommitted changes from an interrupted bunker run"}`.nothrow().quiet();
    }
    if (commits > 0 || dirty) {
      const tag = `bunker/stale/${number}-${stamp()}`;
      if ((await git("tag", tag, l.branch)).exitCode !== 0) continue; // keep the branch rather than lose the work
      kept = tag;
    }
    await worktreeAdmin(l.repo, () => $`git -C ${l.repo} worktree remove --force ${l.worktree}`.nothrow().quiet());
    if (existsSync(l.worktree)) await rm(l.worktree, { recursive: true, force: true });
    await worktreeAdmin(l.repo, () => $`git -C ${l.repo} worktree prune`.nothrow().quiet());
    await worktreeAdmin(l.repo, () => $`git -C ${l.repo} branch -D ${l.branch}`.nothrow().quiet());
  }
  return kept;
}

export function track(l: Live): () => void {
  if (!hooked) {
    hooked = true;
    process.on("exit", cleanupInterrupted);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      // The watch CLI installs its own handler (which exits through the "exit" hook above).
      if (process.listenerCount(sig) === 0) process.on(sig, () => process.exit(130));
    }
  }
  live.add(l);
  return () => void live.delete(l);
}

/**
 * Deal with what an interrupted earlier run left for this issue's branch. Empty leftovers are deleted; work is kept
 * under a `bunker/stale/<n>-<timestamp>` tag; an open PR on origin means the issue is already being handled.
 * Only ever touches `{feature|fix}/<n>-<slug>` for this issue.
 */
export async function reclaimLeftover(o: LeftoverOpts): Promise<{ prUrl?: string; remoteSha?: string }> {
  const { repo, number, branch, worktree, baseSha } = o;
  if (!new RegExp(`^(feature|fix)/${number}-[a-z0-9-]*$`).test(branch)) return {};
  const git = (...args: string[]) => $`git -C ${repo} ${args}`.nothrow().quiet();
  const { prUrl, remoteSha } = await claimRemoteBranch(o);
  if (prUrl) return { prUrl };
  const hasBranch = (await git("rev-parse", "--verify", "-q", `refs/heads/${branch}`)).exitCode === 0;
  const hasDir = existsSync(worktree);
  if (!hasBranch && !hasDir) return { remoteSha };

  let dirty = false;
  if (hasDir) {
    const st = await $`git -C ${worktree} status --porcelain`.nothrow().quiet();
    dirty = st.exitCode === 0 && st.stdout.toString().trim() !== "";
  }
  let commits = 0;
  if (hasBranch) commits = Number((await git("rev-list", "--count", `${baseSha}..${branch}`)).stdout.toString().trim()) || 0;
  if (commits > 0 || dirty) {
    if (dirty) {
      await $`git -C ${worktree} add -A`.nothrow().quiet();
      await $`git -C ${worktree} -c user.name=bunker -c user.email=bunker@localhost commit -q -m ${"wip: uncommitted changes from an interrupted bunker run"}`.nothrow().quiet();
    }
    const tag = `bunker/stale/${number}-${stamp()}`;
    const tagged = await git("tag", tag, hasBranch ? branch : "HEAD");
    if (tagged.exitCode !== 0) throw new Error(`could not keep the leftover work of #${number} as ${tag}:\n${tagged.stderr}`);
    o.log("stale leftover kept", tag);
    emit(o.onEvent, { type: "note", text: `#${number}: kept an interrupted attempt's work as tag ${tag}` });
  }
  await worktreeAdmin(repo, () => $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet());
  if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true });
  await worktreeAdmin(repo, () => $`git -C ${repo} worktree prune`.nothrow().quiet());
  if (hasBranch) await worktreeAdmin(repo, () => $`git -C ${repo} branch -D ${branch}`.nothrow().quiet());
  return { remoteSha };
}
