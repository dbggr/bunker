import { $ } from "bun";
import { redact } from "../core/redact.ts";
import { worktreeAdmin } from "./admin.ts";

export interface Commit {
  sha: string;
  subject: string;
}

export async function commitsBetween(cwd: string, base: string, branch: string): Promise<Commit[]> {
  const out = await $`git -C ${cwd} log --reverse --format=%H%x09%s ${base}..${branch}`.text();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\t");
      return { sha, subject };
    });
}

/** Merges the branch into the caller's checkout and deletes it. On conflict: aborts, keeps the branch, returns the error. */
export async function mergeBack(cwd: string, branch: string, commits: Commit[]): Promise<string | undefined> {
  if (commits.length > 0) {
    const merge = await $`git -C ${cwd} merge -q --no-edit ${branch}`.nothrow().quiet();
    if (merge.exitCode !== 0) {
      await $`git -C ${cwd} merge --abort`.nothrow().quiet();
      return redact(`merge conflict on ${branch}; branch kept:\n${merge.stdout}${merge.stderr}`);
    }
  }
  await worktreeAdmin(cwd, () => $`git -C ${cwd} branch -q -D ${branch}`);
}
