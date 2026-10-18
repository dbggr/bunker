import { $ } from "bun";
import { emit, type OnEvent } from "../core/events.ts";

/** Polls the PR (Pull requests: Read only) until GitHub merged or closed it, or the timeout passed. */
export async function waitForMerge(
  prUrl: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  pollMs: number,
): Promise<{ outcome: "merged" | "closed" | "timeout"; detail?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  for (;;) {
    const view = await $`gh pr view ${prUrl} --json state,mergeCommit`.cwd(cwd).env(env).nothrow().quiet();
    if (view.exitCode === 0) {
      try {
        const state = JSON.parse(view.stdout.toString()).state;
        if (state === "MERGED") return { outcome: "merged" };
        if (state === "CLOSED") return { outcome: "closed", detail: "the PR was closed without merging (state: CLOSED)" };
        lastError = "";
      } catch {
        lastError = "unparseable gh pr view response";
      }
    } else {
      lastError = `gh pr view failed (exit ${view.exitCode}): ${view.stderr}`.trimEnd();
    }
    if (Date.now() >= deadline) {
      return { outcome: "timeout", detail: `PR not merged after ${timeoutMs / 60_000} min; auto-merge stays armed on the PR${lastError ? `\n${lastError}` : ""}` };
    }
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

export type LeftoverOpts = { repo: string; cwd: string; number: number; branch: string; worktree: string; baseSha: string; remote: string; gitCfg: string[]; env: Record<string, string>; log: (t: string, s?: string) => void; onEvent?: OnEvent };

/**
 * Deal with origin's copy of this issue's branch: an open PR means the issue is already being handled; otherwise the
 * remote tip is kept under a tag and its sha returned, so the push can replace it with a lease on exactly that sha.
 */
export async function claimRemoteBranch(o: LeftoverOpts): Promise<{ prUrl?: string; remoteSha?: string }> {
  const { repo, number, branch } = o;
  if (!new RegExp(`^(feature|fix)/${number}-[a-z0-9-]*$`).test(branch)) return {};
  const remoteSha = (await $`git ${o.gitCfg} -C ${repo} ls-remote --heads ${o.remote} ${`refs/heads/${branch}`}`.env(o.env).nothrow().quiet()).stdout.toString().trim().split(/\s+/)[0] || undefined;
  if (remoteSha) {
    const prs = await $`gh pr list --head ${branch} --state open --json url`.cwd(o.cwd).env(o.env).nothrow().quiet();
    // Only a successful lookup with an empty list means "no open PR"; anything else must not lead to replacing the branch.
    let list: { url?: string }[] | undefined;
    try {
      if (prs.exitCode === 0) list = JSON.parse(prs.stdout.toString());
    } catch {}
    if (!Array.isArray(list)) throw new Error(`could not check for an open PR on ${branch} of #${number}:\n${prs.stderr}`);
    const url = list[0]?.url;
    if (url) {
      emit(o.onEvent, { type: "note", text: `#${number} is already in progress: ${url}` });
      return { prUrl: url };
    }
    // No open PR (e.g. a closed one): keep the remote tip under a tag; the push will replace it.
    const tag = `bunker/stale/${number}-remote-${stamp()}`;
    const kept = await $`git ${o.gitCfg} -C ${repo} fetch -q ${o.remote} ${`refs/heads/${branch}:refs/tags/${tag}`}`.env(o.env).nothrow().quiet();
    if (kept.exitCode !== 0) throw new Error(`could not keep origin's ${branch} of #${number} as ${tag}:\n${kept.stderr}`);
    o.log("stale remote branch kept", tag);
    emit(o.onEvent, { type: "note", text: `#${number}: origin already has ${branch} without an open PR; kept it as tag ${tag} and will replace it` });
  }
  return { remoteSha };
}

export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
