import { $ } from "bun";
import { codeSpan } from "../core/redact.ts";
import { output } from "../core/output.ts";
import type { Queued } from "../core/priority.ts";
import { markTrust } from "./trust.ts";
import { QUEUED_LABEL, unqueue } from "./labels.ts";

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  author?: { login?: string } | null;
  authorAssociation?: string;
  state: string;
  labels: { name: string }[];
  /** Oldest first, as `gh issue view --json comments` returns them. */
  comments?: { author?: { login?: string } | null; authorAssociation?: string; body: string; trusted?: boolean }[];
  /** Set by `markTrust`: the body's author has admin/maintain permission. */
  bodyTrusted?: boolean;
}

const CONVENTIONAL_PREFIX = /^\s*(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?:\s*/i;
const MAX_SLUG = 40;

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object";

/** True when a parsed `gh issue view` response has every field runQueue reads in a usable shape. */
export function isLiveShape(live: Record<string, unknown>): boolean {
  const { labels, body, comments } = live;
  return (
    Array.isArray(labels) && labels.every(isObj) &&
    (body == null || typeof body === "string") &&
    (comments == null || (Array.isArray(comments) && comments.every((c) => isObj(c) && typeof c.body === "string")))
  );
}

/** Issue numbers named by `Blocked by #N` / `Depends on #N` (case-insensitive) in the body (if its author is trusted) and trusted comments. */
export function blockerRefs(issue: Pick<IssueInfo, "body" | "comments" | "bodyTrusted">): number[] {
  const texts = [...(issue.bodyTrusted ? [issue.body ?? ""] : []), ...(issue.comments ?? []).filter((c) => c.trusted).map((c) => c.body)];
  const refs = new Set<number>();
  for (const t of texts) for (const m of t.matchAll(/\b(?:blocked\s+by|depends\s+on)\s+#(\d+)/gi)) refs.add(Number(m[1]));
  return [...refs];
}

/** `fix/<N>-<slug>` for a bug-labelled issue, else `feature/<N>-<slug>`. */
export function issueBranch(issue: Pick<IssueInfo, "number" | "title" | "labels">): { branch: string; slug: string } {
  let slug = issue.title
    .replace(CONVENTIONAL_PREFIX, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > MAX_SLUG) {
    // Cut at a word boundary; a single over-long word is cut hard.
    const cut = slug.lastIndexOf("-", MAX_SLUG);
    slug = slug.slice(0, cut > 0 ? cut : MAX_SLUG);
  }
  const type = issue.labels.some((l) => l.name === "bug") ? "fix" : "feature";
  return { branch: `${type}/${issue.number}-${slug}`, slug };
}

const BLOCKED_LABEL = "bunker-blocked";

export type Env = Record<string, string>;

/** Swaps `bunker:queued` for `bunker-blocked` on the issue and says what it waits on. */
export async function markBlocked(issue: number, blocker: { number: number; title: string }, cwd: string, env: Env, mention?: string): Promise<void> {
  await $`gh label create ${BLOCKED_LABEL} --description ${"waiting on another issue; bunker relabels it `bunker:queued` once that is closed"} --color FBCA04`.cwd(cwd).env(env).nothrow().quiet();
  const edit = await unqueue(issue, cwd, env, ["--add-label", BLOCKED_LABEL]);
  if (edit.exitCode !== 0) output.warn(`bunker: could not relabel #${issue}: ${edit.stderr.toString().trim()}`);
  await $`gh issue comment ${issue} --body ${`${mention ? `${mention} ` : ""}Blocked by #${blocker.number}: ${codeSpan(blocker.title)}`}`.cwd(cwd).env(env).nothrow().quiet();
}

/** Whether #n is closed (any reason, incl. not planned: a rejected blocker no longer blocks); undefined if gh can't say. */
export async function isDone(n: number, cwd: string, env: Env): Promise<boolean | undefined> {
  const v = await $`gh issue view ${n} --json state`.cwd(cwd).env(env).nothrow().quiet();
  if (v.exitCode !== 0) return undefined;
  try {
    const j = JSON.parse(v.stdout.toString()) as { state: string };
    return j.state.toUpperCase() === "CLOSED";
  } catch {
    return undefined;
  }
}

/** Open issues labelled `bunker-blocked` whose blockers are all closed go back to `bunker:queued`. Best effort. */
export async function resumeBlocked(cwd: string, env: Env): Promise<Queued[]> {
  const list = await $`gh issue list --label ${BLOCKED_LABEL} --state open --limit 1000 --json number,title,createdAt`.cwd(cwd).env(env).nothrow().quiet();
  if (list.exitCode !== 0) return [];
  let found: { number: number; title?: unknown; createdAt?: unknown }[];
  try {
    found = JSON.parse(list.stdout.toString());
  } catch {
    return [];
  }
  const resumed: Queued[] = [];
  for (const { number: n, title, createdAt } of found) {
    const v = await $`gh issue view ${n} --json body,author,comments,state,labels`.cwd(cwd).env(env).nothrow().quiet();
    if (v.exitCode !== 0) continue;
    let info: IssueInfo;
    try {
      info = JSON.parse(v.stdout.toString());
    } catch {
      continue;
    }
    if (info.state.toUpperCase() !== "OPEN" || !info.labels.some((l) => l.name === BLOCKED_LABEL)) continue;
    await markTrust(info, cwd, env);
    const refs = blockerRefs(info);
    if (!refs.length) continue;
    const states = await Promise.all(refs.map((r) => isDone(r, cwd, env)));
    if (!states.every((s) => s === true)) continue;
    const edit = await $`gh issue edit ${n} --remove-label ${BLOCKED_LABEL} --add-label ${QUEUED_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
    if (edit.exitCode !== 0) continue;
    await $`gh issue comment ${n} --body ${`Unblocked: ${refs.map((r) => `#${r}`).join(", ")} ${refs.length === 1 ? "is" : "are"} closed`}`.cwd(cwd).env(env).nothrow().quiet();
    resumed.push({ number: n, title: typeof title === "string" ? title : "", createdAt: typeof createdAt === "string" ? createdAt : "", labels: [{ name: QUEUED_LABEL }] });
  }
  return resumed;
}
