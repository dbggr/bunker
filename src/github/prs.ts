import { $ } from "bun";

type Env = Record<string, string>;

export interface PrComment {
  body: string;
  /** Login of the comment's author ("" when GitHub gave none). */
  author: string;
}

/** An open pull request opened by a bunker run, with what the shepherd decides on. */
export interface BunkerPr {
  number: number;
  url: string;
  /** The issue it closes. */
  issue: number;
  branch: string;
  base: string;
  headSha: string;
  isDraft: boolean;
  labels: string[];
  mergeable: string;
  mergeState: string;
  reviewDecision: string;
  autoMerge: boolean;
  comments: PrComment[];
}

const FIELDS = "number,url,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,body,labels,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,comments";

const BRANCH = /^(?:feature|fix)\/(\d+)-/;

/**
 * A bunker PR is one from a branch of this repo named `feature|fix/<n>-…` whose body says `Closes #<n>`. A PR from a fork never
 * counts: the shepherd pushes to the branch, and a fork's branch is not ours to push to (nor its logs ours to trust).
 */
export function parseBunkerPrs(raw: unknown): BunkerPr[] {
  if (!Array.isArray(raw)) return [];
  const out: BunkerPr[] = [];
  for (const p of raw as Record<string, any>[]) {
    if (!p || typeof p !== "object" || p.isCrossRepository !== false) continue;
    const m = BRANCH.exec(String(p.headRefName ?? ""));
    if (!m || typeof p.number !== "number" || typeof p.url !== "string") continue;
    const issue = Number(m[1]);
    if (!new RegExp(`(^|\\n)Closes #${issue}\\b`).test(String(p.body ?? ""))) continue;
    out.push({
      number: p.number,
      url: p.url,
      issue,
      branch: p.headRefName,
      base: String(p.baseRefName ?? "main"),
      headSha: String(p.headRefOid ?? ""),
      isDraft: p.isDraft === true,
      labels: Array.isArray(p.labels) ? p.labels.flatMap((l: any) => (typeof l?.name === "string" ? [l.name] : [])) : [],
      mergeable: String(p.mergeable ?? "UNKNOWN"),
      mergeState: String(p.mergeStateStatus ?? "UNKNOWN"),
      reviewDecision: String(p.reviewDecision ?? ""),
      autoMerge: !!p.autoMergeRequest,
      comments: Array.isArray(p.comments) ? p.comments.map((c: any) => ({ body: String(c?.body ?? ""), author: String(c?.author?.login ?? "") })) : [],
    });
  }
  return out;
}

/** Open bunker PRs, or undefined when gh can't say (never "none" on an error). */
export async function listBunkerPrs(cwd: string, env: Env): Promise<BunkerPr[] | undefined> {
  const r = await $`gh pr list --state open --limit 200 --json ${FIELDS}`.cwd(cwd).env(env).nothrow().quiet();
  if (r.exitCode !== 0) return undefined;
  try {
    return parseBunkerPrs(JSON.parse(r.stdout.toString()));
  } catch {
    return undefined;
  }
}

/** How a bunker PR ended: merged, or closed without merging. */
export interface PrOutcome {
  pr: number;
  url: string;
  issue: number;
  outcome: "merged" | "closed";
  /** Epoch ms of the merge or close. */
  at: number;
}

/**
 * The final state of each issue's latest bunker PR that merged or closed since `sinceMs`; an issue with a PR still open is left out.
 * Undefined when gh can't say.
 */
export async function listRecentPrOutcomes(cwd: string, env: Env, sinceMs: number): Promise<PrOutcome[] | undefined> {
  const r = await $`gh pr list --state all --limit 200 --json ${FIELDS + ",state,mergedAt,closedAt"}`.cwd(cwd).env(env).nothrow().quiet();
  if (r.exitCode !== 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout.toString() || "[]");
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const prs = parseBunkerPrs(raw);
  const byNumber = new Map((raw as Record<string, any>[]).map((p) => [p?.number, p]));
  const open = new Set<number>();
  const latest = new Map<number, PrOutcome>();
  for (const pr of prs) {
    const p = byNumber.get(pr.number)!;
    if (p.state === "OPEN") {
      open.add(pr.issue);
      continue;
    }
    const merged = p.state === "MERGED";
    const at = Date.parse(String(merged ? p.mergedAt : p.closedAt));
    if (!merged && p.state !== "CLOSED") continue;
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const o = latest.get(pr.issue);
    if (!o || at > o.at) latest.set(pr.issue, { pr: pr.number, url: pr.url, issue: pr.issue, outcome: merged ? "merged" : "closed", at });
  }
  return [...latest.values()].filter((o) => !open.has(o.issue));
}
