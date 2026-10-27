import { $ } from "bun";
import { output } from "../core/output.ts";
import type { Queued } from "../core/priority.ts";
import { blockerRefs, isDone, isLiveShape, type Env, type IssueInfo } from "./issues.ts";
import { hasExcludeLabel, hasQueuedLabel, QUEUED_LABEL } from "./labels.ts";
import { markTrust } from "./trust.ts";

export async function listQueued(cwd: string, env: Env): Promise<Queued[]> {
  return listLabelled(QUEUED_LABEL, cwd, env);
}

async function listLabelled(label: string, cwd: string, env: Env): Promise<Queued[]> {
  const list = await $`gh issue list --label ${label} --state open --limit 1000 --json number,title,createdAt,labels`.cwd(cwd).env(env).nothrow().quiet();
  if (list.exitCode !== 0) {
    output.warn(`bunker: gh issue list failed:\n${list.stderr}`);
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(list.stdout.toString());
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.filter((i): i is Queued => i !== null && typeof i === "object" && typeof i.number === "number" && typeof i.title === "string" && typeof i.createdAt === "string").map((i) => ({ ...i, labels: Array.isArray(i.labels) ? i.labels.filter((l) => l !== null && typeof l === "object" && typeof l.name === "string") : [] }));
  } catch {
    output.warn("bunker: gh issue list returned unparseable output");
    return [];
  }
}

/** Open `bunker:queued` issues that could start now: not in `skip`, not waiting on an open `Blocked by #N` issue. */
export async function countWaiting(cwd: string, env: Env, skip: (issue: number) => boolean | Promise<boolean> = () => false): Promise<number> {
  let n = 0;
  for (const q of await listQueued(cwd, env)) {
    if (await skip(q.number)) continue;
    const view = await $`gh issue view ${q.number} --json state,labels,body,author,comments`.cwd(cwd).env(env).nothrow().quiet();
    if (view.exitCode !== 0) continue;
    let live: Pick<IssueInfo, "state" | "labels" | "body" | "author" | "comments" | "bodyTrusted">;
    try {
      live = JSON.parse(view.stdout.toString());
      if (live === null || typeof live !== "object" || !isLiveShape(live)) continue;
    } catch {
      continue;
    }
    if (live.state !== "OPEN" || !hasQueuedLabel(live.labels) || hasExcludeLabel(live.labels)) continue;
    let blocked = false;
    await markTrust(live, cwd, env);
    for (const ref of blockerRefs(live)) {
      if ((await isDone(ref, cwd, env)) === false) {
        blocked = true;
        break;
      }
    }
    if (!blocked) n++;
  }
  return n;
}
