import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string>;

const MAINTAINER_ROLES = new Set(["admin", "maintain"]);

export type LabelerCheck = { ok: true; adder: string } | { ok: false; adder?: string; reason: string; denied: boolean };

/**
 * Who added the current `bunker` label (latest `labeled` event) and whether they may queue work: a repo `admin` or
 * `maintain`er, or one of `allow`. Any lookup failure is a refusal with `denied: false` (fail closed, nothing to tell the adder).
 */
export async function checkLabeler(issue: number, opts: { cwd: string; env: Env; allow?: string[] }): Promise<LabelerCheck> {
  const { cwd, env } = opts;
  const events = await $`gh api repos/{owner}/{repo}/issues/${issue}/events --paginate --jq ${'.[] | select(.event == "labeled" and .label.name == "bunker") | .actor.login'}`.cwd(cwd).env(env).nothrow().quiet();
  if (events.exitCode !== 0) return { ok: false, denied: false, reason: `could not read the label events of #${issue}: ${events.stderr.toString().trim()}` };
  const adder = events.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!adder) return { ok: false, denied: false, reason: `no \`bunker\` label event found on #${issue} (add the label first: --issue checks who labeled it)` };
  if (opts.allow?.some((a) => a.toLowerCase() === adder.toLowerCase())) return { ok: true, adder };
  const perm = await $`gh api repos/{owner}/{repo}/collaborators/${adder}/permission --jq .role_name`.cwd(cwd).env(env).nothrow().quiet();
  if (perm.exitCode !== 0) return { ok: false, adder, denied: false, reason: `could not look up @${adder}'s permission (the token needs to read it): ${perm.stderr.toString().trim()}` };
  const role = perm.stdout.toString().trim();
  if (MAINTAINER_ROLES.has(role)) return { ok: true, adder };
  return { ok: false, adder, denied: true, reason: `@${adder} has ${role || "unknown"} permission, not admin or maintain` };
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
    const edit = await $`gh issue edit ${issue} --remove-label bunker`.cwd(cwd).env(env).nothrow().quiet();
    if (edit.exitCode !== 0) log(`bunker: could not remove the label from #${issue}: ${edit.stderr.toString().trim()}`);
    await $`gh issue comment ${issue} --body ${`@${r.adder} only maintainers can queue bunker work`}`.cwd(cwd).env(env).nothrow().quiet();
  }
  return false;
}

/** `allow-labelers = ["login", ...]` from ~/.config/bunker/config.toml (user-level only: a repo file could widen its own gate). */
export async function configAllowedLabelers(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const file = Bun.file(join(env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config"), "bunker", "config.toml"));
  if (!(await file.exists())) return [];
  const parsed = Bun.TOML.parse(await file.text()) as { "allow-labelers"?: unknown };
  const v = parsed["allow-labelers"];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    if (v !== undefined) throw new Error("config.toml: allow-labelers must be a list of GitHub logins");
    return [];
  }
  return v;
}
