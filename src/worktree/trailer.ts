import { $ } from "bun";

/** Commit trailer on every commit bunker creates; the v1-readiness report reads it to tell bunker's commits from a human's. */
export const RUN_TRAILER = "Bunker-Run";

/** True when the last paragraph of the message is a trailer block containing `Bunker-Run:`. */
export const hasRunTrailer = (message: string): boolean => {
  const last = message.trim().split(/\n\s*\n/).at(-1) ?? "";
  return last.split("\n").some((l) => l.startsWith(`${RUN_TRAILER}: `));
};

/**
 * Rewrites the commits reachable from `tip` but not from `exclude` so each carries `Bunker-Run: <value>`, keeping trees, authors,
 * dates and merge structure. Returns the new tip (the old one when nothing needed a trailer). The caller moves its branch.
 */
export async function stampCommits(cwd: string, tip: string, exclude: string[], value: string): Promise<string> {
  const list = (await $`git -C ${cwd} rev-list --reverse --topo-order --parents ${tip} ${exclude.map((e) => `^${e}`)}`.text()).split("\n").filter(Boolean);
  const mapped = new Map<string, string>();
  let changed = false;
  for (const line of list) {
    const [sha = "", ...parents] = line.split(" ");
    const newParents = parents.map((p) => mapped.get(p) ?? p);
    const meta = (await $`git -C ${cwd} log -1 --format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%T ${sha}`.text()).trimEnd().split("\0");
    const [an = "", ae = "", ad = "", cn = "", ce = "", cd = "", tree = ""] = meta;
    const message = await $`git -C ${cwd} log -1 --format=%B ${sha}`.text();
    const stamped = hasRunTrailer(message) ? message : (await $`git -C ${cwd} interpret-trailers --trailer ${`${RUN_TRAILER}: ${value}`} < ${new Response(message)}`.text());
    if (stamped === message && newParents.every((p, i) => p === parents[i])) {
      mapped.set(sha, sha);
      continue;
    }
    changed = true;
    const out = await $`git -C ${cwd} commit-tree ${tree} ${newParents.flatMap((p) => ["-p", p])} -F - < ${new Response(stamped)}`
      .env({ ...process.env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd })
      .text();
    mapped.set(sha, out.trim());
  }
  const resolved = (await $`git -C ${cwd} rev-parse ${tip}`.text()).trim();
  return changed ? mapped.get(resolved) ?? resolved : resolved;
}
