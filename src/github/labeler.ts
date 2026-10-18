import { $ } from "bun";
import { readUserConfig } from "../core/user-config.ts";
import { QUEUED_EVENT_JQ, unqueue } from "./labels.ts";

type Env = Record<string, string>;

export const MAINTAINER_ROLES = new Set(["admin", "maintain"]);

export type LabelerCheck = { ok: true; adder: string } | { ok: false; adder?: string; reason: string; denied: boolean; comment?: string };

/**
 * Who added the current `bunker:queued` label (latest `labeled` event) and whether they may queue work: a repo `admin` or
 * `maintain`er, or one of `allow`. Any lookup failure is a refusal with `denied: false` (fail closed, nothing to tell the adder).
 */
export async function checkLabeler(issue: number, opts: { cwd: string; env: Env; allow?: string[] }): Promise<LabelerCheck> {
  const { cwd, env } = opts;
  const events = await $`gh api repos/{owner}/{repo}/issues/${issue}/events --paginate --jq ${`.[] | select(${QUEUED_EVENT_JQ}) | .actor.login`}`.cwd(cwd).env(env).nothrow().quiet();
  if (events.exitCode !== 0) return { ok: false, denied: false, reason: `could not read the label events of #${issue}: ${events.stderr.toString().trim()}` };
  const adder = events.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!adder) return { ok: false, denied: false, reason: `no \`bunker:queued\` label event found on #${issue} (add the label first: \`bunker issue\` checks who labeled it)` };
  const allowed = (login: string) => opts.allow?.some((a) => a.toLowerCase() === login.toLowerCase()) ?? false;
  if (!allowed(adder)) {
    const denied = await checkPermission(adder, opts);
    if (denied) return denied;
  }
  return checkEditedSince(issue, adder, opts, allowed);
}

/** Refusal if `adder` is neither admin nor maintain; undefined when they are. */
async function checkPermission(adder: string, opts: { cwd: string; env: Env }): Promise<LabelerCheck | undefined> {
  const { cwd, env } = opts;
  const perm = await $`gh api repos/{owner}/{repo}/collaborators/${adder}/permission --jq .role_name`.cwd(cwd).env(env).nothrow().quiet();
  if (perm.exitCode !== 0) return { ok: false, adder, denied: false, reason: `could not look up @${adder}'s permission (the token needs to read it): ${perm.stderr.toString().trim()}` };
  const role = perm.stdout.toString().trim();
  if (MAINTAINER_ROLES.has(role)) return undefined;
  return { ok: false, adder, denied: true, reason: `@${adder} has ${role || "unknown"} permission, not admin or maintain` };
}

/**
 * The maintainer gate checks who labelled, but the body is read later: an outsider could swap it after the label. Refuse when the
 * body or title was edited after the latest `bunker:queued` label by anyone who is not admin/maintain/allowed. Fails closed on any error.
 */
async function checkEditedSince(issue: number, adder: string, opts: { cwd: string; env: Env }, allowed: (login: string) => boolean): Promise<LabelerCheck> {
  const { cwd, env } = opts;
  const fail = (why: string): LabelerCheck => ({ ok: false, adder, denied: false, reason: `could not check #${issue} for edits after labelling: ${why}` });
  const labeledAt = await latestBunkerLabeledAt(issue, opts);
  if (labeledAt === undefined) return fail("no label time");
  const query = "query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){lastEditedAt userContentEdits(first:100){nodes{editedAt editor{login}}}}}}";
  const jq = '.data.repository.issue | ("last\t" + (.lastEditedAt // "")), (.userContentEdits.nodes[] | "edit\t" + .editedAt + "\t" + (.editor.login // ""))';
  const gql = await $`gh api graphql -F owner={owner} -F repo={repo} -F n=${issue} -f query=${query} --jq ${jq}`.cwd(cwd).env(env).nothrow().quiet();
  if (gql.exitCode !== 0) return fail(gql.stderr.toString().trim());
  const renamed = await $`gh api repos/{owner}/{repo}/issues/${issue}/events --paginate --jq ${'.[] | select(.event == "renamed") | "edit\t" + .created_at + "\t" + (.actor.login // "")'}`.cwd(cwd).env(env).nothrow().quiet();
  if (renamed.exitCode !== 0) return fail(renamed.stderr.toString().trim());
  const lines = (gql.stdout.toString() + "\n" + renamed.stdout.toString()).split("\n").map((l) => l.trim()).filter(Boolean);
  const edits: { at: number; login: string }[] = [];
  let last: number | undefined;
  for (const line of lines) {
    const [kind, at = "", login = ""] = line.split("\t");
    if (kind === "last" && !at) continue;
    const t = Date.parse(at);
    if (Number.isNaN(t)) return fail(`bad timestamp "${at}"`);
    if (kind === "last") last = t;
    else if (kind === "edit") edits.push({ at: t, login });
  }
  const refuse = (): LabelerCheck => ({ ok: false, adder, denied: true, reason: `#${issue} was edited after it was labelled bunker:queued`, comment: `@${adder} issue was edited after it was queued; re-check and relabel` });
  const later = edits.filter((e) => e.at > labeledAt);
  if (later.length === 0 && last !== undefined && last > labeledAt) return refuse(); // edited, but by whom is unknown
  const trusted = new Map<string, boolean>();
  for (const e of later) {
    if (!e.login) return refuse();
    const key = e.login.toLowerCase();
    if (!trusted.has(key)) {
      if (allowed(e.login)) trusted.set(key, true);
      else {
        const r = await checkPermission(e.login, opts);
        if (r && !r.ok && !r.denied) return fail(r.reason);
        trusted.set(key, !r);
      }
    }
    if (!trusted.get(key)) return refuse();
  }
  return { ok: true, adder };
}

/** When the latest `bunker:queued` label was added (ms since epoch); undefined if there is no such event or the lookup failed. */
export async function latestBunkerLabeledAt(issue: number, opts: { cwd: string; env: Env }): Promise<number | undefined> {
  const events = await $`gh api repos/{owner}/{repo}/issues/${issue}/events --paginate --jq ${`.[] | select(${QUEUED_EVENT_JQ}) | .created_at`}`.cwd(opts.cwd).env(opts.env).nothrow().quiet();
  if (events.exitCode !== 0) return undefined;
  const last = events.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
  const at = last ? Date.parse(last) : NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** Checks the labeler; when refused for lack of permission, removes the label and says why on the issue. True if the issue may be worked. */
export async function enforceLabeler(issue: number, opts: { cwd: string; env: Env; allow?: string[]; log?: (text: string) => void; onRefused?: () => void }): Promise<boolean> {
  const log = opts.log ?? ((t: string) => console.warn(t));
  const r = await checkLabeler(issue, opts);
  if (r.ok) return true;
  log(`bunker: skipping #${issue}: ${r.reason}`);
  opts.onRefused?.();
  if (r.denied) {
    const { cwd, env } = opts;
    const edit = await unqueue(issue, cwd, env);
    if (edit.exitCode !== 0) log(`bunker: could not remove the label from #${issue}: ${edit.stderr.toString().trim()}`);
    await $`gh issue comment ${issue} --body ${r.comment ?? `@${r.adder} only maintainers can queue bunker work`}`.cwd(cwd).env(env).nothrow().quiet();
  }
  return false;
}

/** `allow_labelers = ["login", ...]` from ~/.config/bunker/config.toml (user-level only: a repo file could widen its own gate). */
export async function configAllowedLabelers(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const parsed = await readUserConfig(env);
  const v = parsed["allow_labelers"];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    if (v !== undefined) throw new Error("config.toml: allow_labelers must be a list of GitHub logins");
    return [];
  }
  return v;
}
