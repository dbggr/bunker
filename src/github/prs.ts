import { $ } from "bun";

type Env = Record<string, string>;

export interface PrComment {
  body: string;
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
      comments: Array.isArray(p.comments) ? p.comments.map((c: any) => ({ body: String(c?.body ?? "") })) : [],
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
