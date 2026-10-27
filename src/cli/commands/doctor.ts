import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { removedUserKeys, readUserConfigRaw, userConfigPath } from "../../core/user-config.ts";
import { formatSpend, loadSpendCaps } from "../../core/spend.ts";
import { capSources, capsFrom } from "../../core/settings.ts";
import { AUTH_VARS, loadBunkerEnv } from "../../core/env.ts";
import { DEFAULT_MODEL_LABEL, resolveModels } from "../../agents/models.ts";
import { DEFAULT_REVIEW_PATHS } from "../../worktree/steering.ts";
import { ConfigError, effectiveSettings, formatValue, loadRepoConfig } from "../../core/config.ts";
import { redact } from "../../core/redact.ts";
import { unpullable } from "../../sandboxes/services.ts";
import { AGENT_NETWORK } from "../../sandboxes/container.ts";
import { bridgeName, firewallRules, rulesBlock } from "../../sandboxes/firewall.ts";
import { applyIdentity, identityKind } from "../../github/identity.ts";
import { AWAITING_REVIEW_LABEL, FAILED_LABEL, IN_PROGRESS_LABEL, QUEUED_LABEL, REVIEW_LABEL } from "../../github/labels.ts";
import { SKILL_ROLES, SkillError, resolveSkills, skillPaths } from "../../core/skills.ts";
import { PRIORITY_LABELS } from "../../core/priority.ts";
import { requiredCheck } from "../../core/required-check.ts";

type Env = Record<string, string | undefined>;

/** Pre-1.0 label names bunker no longer reads or writes, with their replacements. */
export const OLD_LABELS: Record<string, string> = { bunker: QUEUED_LABEL, "bunker-failed": FAILED_LABEL, "needs-human-review": REVIEW_LABEL };

/** Filed on follow-ups and audit findings; filing falls back to no severity label without them, so they are optional. */
export const SEVERITY_LABELS = ["severity:high", "severity:medium"] as const;
/** Only manual-merge mode applies this one; it is created by bunker on first use, so it is optional too. */
export const OPTIONAL_LABELS: readonly string[] = [...SEVERITY_LABELS, AWAITING_REVIEW_LABEL];
export const LABELS = [QUEUED_LABEL, IN_PROGRESS_LABEL, FAILED_LABEL, REVIEW_LABEL, AWAITING_REVIEW_LABEL, "discovered", "bunker-blocked", ...PRIORITY_LABELS.map((p) => p.name), ...SEVERITY_LABELS] as const;

/** Total bytes of the files under `dir` (0 if missing); symlinks are not followed. */
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : lstatSync(p).size;
    }
  } catch {}
  return total;
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

export interface Check {
  id: string;
  group: "tools" | "auth" | "repo" | "config" | "github" | "models" | "spend";
  label: string;
  ok: boolean;
  /** Only required checks decide the exit code; an optional ✗ is shown as a note. */
  required: boolean;
  detail?: string;
  fix?: string;
}

export interface RepoInfo {
  slug: string;
  owner: string;
  name: string;
}

export interface Exec {
  code: number;
  out: string;
  err: string;
}

/** Runs a command to completion. Secrets go in `env`, never argv. A missing binary is code 127. */
export async function exec(cmd: string[], opts: { cwd?: string; env?: Env } = {}): Promise<Exec> {
  try {
    const p = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code: p.exitCode ?? 1, out, err };
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

/** owner/repo from a GitHub remote URL (https, ssh or git@), else undefined. */
export function parseGithubRemote(url: string): RepoInfo | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]!, slug: `${m[1]}/${m[2]}` } : undefined;
}

/** Env for gh calls that act as the scoped bunker token. */
export const scopedEnv = (env: Env): Env => (env.BUNKER_GH_TOKEN ? { ...env, GH_TOKEN: env.BUNKER_GH_TOKEN } : env);

/** Env for gh calls that need your own login (repo settings): the scoped token can't read those. */
export const userEnv = (env: Env): Env => {
  const e = { ...env };
  delete e.GH_TOKEN;
  delete e.GITHUB_TOKEN;
  return e;
};

/** Probes what the scoped token can read; returns the names of the permissions that are missing. */
export async function probeGhToken(repo: RepoInfo, defaultBranch: string, env: Env): Promise<{ missing: string[]; repoJson?: Record<string, unknown> }> {
  const e = scopedEnv(env);
  const base = `repos/${repo.slug}`;
  const probes: [string, string][] = [
    ["Metadata (repo read)", base],
    ["Contents", `${base}/branches/${defaultBranch}`],
    ["Issues", `${base}/issues?per_page=1`],
    ["Pull requests", `${base}/pulls?per_page=1`],
    ["Actions", `${base}/actions/runs?per_page=1`],
  ];
  const results = await Promise.all(probes.map(([, path]) => exec(["gh", "api", path], { env: e })));
  const missing = probes.filter((_, i) => results[i]!.code !== 0).map(([name]) => name);
  let repoJson: Record<string, unknown> | undefined;
  try {
    repoJson = JSON.parse(results[0]!.out);
  } catch {}
  return { missing, ...(repoJson ? { repoJson } : {}) };
}

export const TOKEN_FIX =
  "create a fine-grained token for this one repo with Contents RW, Pull requests RW, Issues RW, Actions R, Metadata R (nothing else) at https://github.com/settings/personal-access-tokens/new, then set BUNKER_GH_TOKEN in ~/.config/bunker/.env (`bunker init` does this)";

export async function runDoctor(opts: { cwd: string; env?: Env; fetch?: typeof globalThis.fetch }): Promise<{ checks: Check[]; code: number; repo?: RepoInfo; defaultBranch?: string }> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd;
  await loadBunkerEnv(cwd, env);
  const checks: Check[] = [];
  const add = (c: Omit<Check, "required"> & { required?: boolean }) => checks.push({ required: true, ...c });

  // tools
  const [docker, git, gh, claude] = await Promise.all([
    exec(["docker", "info"], { env }),
    exec(["git", "--version"], { env }),
    exec(["gh", "auth", "status"], { env: userEnv(env) }),
    exec(["claude", "--version"], { env }),
  ]);
  const authed = AUTH_VARS.some((v) => !!env[v]);
  add({ id: "docker", group: "tools", label: "docker reachable", ok: docker.code === 0, fix: "install Docker (or Podman) and start the daemon" });
  add({ id: "git", group: "tools", label: "git", ok: git.code === 0, fix: "install git" });
  add({ id: "gh", group: "tools", label: "gh authenticated", ok: gh.code === 0, fix: "install the GitHub CLI and run `gh auth login`" });
  add({ id: "claude", group: "tools", label: "claude present", ok: claude.code === 0, required: !authed, fix: "install Claude Code (needed for `claude setup-token`)" });

  // the agent bridge can still reach the LAN and the gateway without host firewall rules (#530); bunker cannot install them without root
  if (docker.code === 0) {
    const net = await exec(["docker", "network", "inspect", AGENT_NETWORK, "--format", "{{.Id}} {{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}"], { env });
    const [id, subnet, gateway] = net.out.trim().split(/\s+/);
    if (net.code === 0 && id && subnet && gateway) {
      const n = { bridge: bridgeName(id), subnet, gateway };
      const [du, inp] = await Promise.all([exec(["iptables", "-S", "DOCKER-USER"], { env }), exec(["iptables", "-S", "INPUT"], { env })]);
      const readable = du.code === 0 && inp.code === 0;
      add({
        id: "agent-firewall",
        group: "tools",
        label: `${AGENT_NETWORK} network blocks the LAN and the gateway (optional)`,
        ok: readable && rulesBlock(n, du.out, inp.out),
        required: false,
        ...(readable ? {} : { detail: "could not read iptables rules (needs root)" }),
        fix: `as root, run: ${firewallRules(n).join("; ")}`,
      });
    }
  }

  // auth
  const authVar = AUTH_VARS.find((v) => !!env[v]);
  add({
    id: "auth-claude",
    group: "auth",
    label: authVar ? `${authVar} set` : "CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY set",
    ok: !!authVar,
    fix: "run `claude setup-token` and put the token in ~/.config/bunker/.env as CLAUDE_CODE_OAUTH_TOKEN=<token> (`bunker init` does this)",
  });

  // repo
  const top = await exec(["git", "rev-parse", "--show-toplevel"], { cwd, env });
  const isRepo = top.code === 0;
  add({ id: "repo", group: "repo", label: "git repository", ok: isRepo, fix: "run bunker from inside a git checkout" });
  const root = isRepo ? top.out.trim() : cwd;
  let repo: RepoInfo | undefined;
  if (isRepo) {
    const origin = await exec(["git", "remote", "get-url", "origin"], { cwd, env });
    repo = origin.code === 0 ? parseGithubRemote(origin.out) : undefined;
    add({
      id: "origin",
      group: "repo",
      label: "origin on GitHub",
      ok: !!repo,
      ...(repo ? { detail: repo.slug } : {}),
      fix: "add a GitHub remote: git remote add origin git@github.com:<owner>/<repo>.git",
    });
  }
  const file = (name: string) => existsSync(join(root, ".bunker", name));
  let loaded: Awaited<ReturnType<typeof loadRepoConfig>> | undefined;
  try {
    loaded = await loadRepoConfig(root, { lenient: true });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    add({ id: "config", group: "config", label: ".bunker/config.toml", ok: false, detail: e.message, fix: "fix the key named above (see `bunker --help`, Repo config)" });
  }
  const cfg = loaded?.config;
  const legacy = loaded?.legacy ?? {};
  if (loaded?.present) add({ id: "config", group: "config", label: ".bunker/config.toml", ok: true, detail: loaded.warnings.length ? loaded.warnings.join("; ") : "valid" });
  for (const f of loaded?.removedFiles ?? []) add({ id: "config-removed-file", group: "config", label: `.bunker/${f}`, ok: false, detail: "no longer read", fix: `move it to \`${f} = "…"\` in .bunker/config.toml and delete the file` });
  if (loaded) for (const s of effectiveSettings({ config: loaded.config, legacy: loaded.legacy, env })) add({ id: `setting-${s.key}`, group: "config", label: s.key, ok: true, required: false, detail: `${formatValue(s.value)} (${s.source})` });
  if (loaded) {
    const paths = [...DEFAULT_REVIEW_PATHS.map((p) => `${p} (default)`), ...(cfg?.review_paths ?? []).map((p) => `${p} (config.toml)`)];
    add({ id: "review-paths", group: "config", label: "review paths", ok: true, required: false, detail: `${paths.join(", ")}; plus .bunker/, .github/, .claude/, CLAUDE.md, AGENTS.md (always)` });
  }
  add({ id: "verify", group: "repo", label: "verify command", ok: !!cfg?.verify, fix: "set verify in .bunker/config.toml with the command that must pass before pushing, e.g. `bun test && bun run typecheck` (`bunker init` proposes one)" });
  add({ id: "setup", group: "repo", label: "setup command (optional)", ok: !!cfg?.setup, required: false, fix: "runs in each worktree before the agent, e.g. `bun install --frozen-lockfile`" });
  // services started for verify: shown, and their images must be pullable
  if (cfg && Object.keys(cfg.services).length) {
    const bad = docker.code === 0 ? await unpullable("docker", cfg.services, env) : [];
    for (const [name, s] of Object.entries(cfg.services)) {
      const err = bad.find((b) => b.name === name);
      add({
        id: `service-${name}`,
        group: "config",
        label: `service ${name}`,
        ok: docker.code === 0 && !err,
        detail: `${s.image}${s.healthcheck ? ", healthcheck" : ""}${err ? `: cannot pull (${err.error})` : ""}`,
        fix: docker.code === 0 ? `check the image name and registry access: docker pull ${s.image}` : "docker must be reachable to pull service images",
      });
    }
    if (!cfg.verify) add({ id: "services-verify", group: "config", label: "services need a verify command", ok: false, required: false, fix: "services only start for verify; set verify in .bunker/config.toml" });
  }
  add({ id: "dockerfile", group: "repo", label: ".bunker/Dockerfile (optional)", ok: file("Dockerfile"), required: false, fix: "starts with `FROM bunker-claude`; adds the toolchain the base image lacks" });
  add({ id: "copy", group: "repo", label: "copy list (optional)", ok: !!cfg?.copy || !!legacy.copy, required: false, fix: "list gitignored files tests need (e.g. .env) as copy = [\".env\"] in .bunker/config.toml" });

  // the scoped token + GitHub settings need the repo and gh
  let defaultBranch: string | undefined;
  let repoJson: Record<string, unknown> | undefined;
  const ghUsable = gh.code === 0 && !!repo;
  if (repo && gh.code === 0) {
    const r = await exec(["gh", "api", `repos/${repo.slug}`], { env: userEnv(env) });
    try {
      repoJson = JSON.parse(r.out);
      defaultBranch = String(repoJson!.default_branch);
    } catch {}
  }
  if (repo) add({ id: "default-branch", group: "repo", label: "default branch", ok: !!defaultBranch, required: false, ...(defaultBranch ? { detail: defaultBranch } : {}), fix: "check `gh auth status` and that you can read the repo" });

  // the identity bunker acts as: the owner's PAT unless a GitHub App or bot account is configured
  const kind = identityKind(env);
  let ghEnv: Env = env;
  let idDetail = "the owner's PAT (BUNKER_GH_TOKEN)";
  if (kind !== "pat") {
    const scratch: Env = { ...env };
    try {
      const id = await applyIdentity(scratch, repo?.slug ?? "", { ...(opts.fetch ? { fetch: opts.fetch } : {}) });
      id.stop();
      ghEnv = scratch;
      idDetail = kind === "app" ? `GitHub App ${env.BUNKER_APP_ID} (installation token)` : `bot account${scratch.BUNKER_IDENTITY_LOGIN ? ` ${scratch.BUNKER_IDENTITY_LOGIN}` : ""} (BUNKER_BOT_GH_TOKEN)`;
    } catch (e) {
      add({ id: "identity", group: "auth", label: `identity: ${kind === "app" ? "GitHub App" : "bot account"}`, ok: false, detail: redact(e instanceof Error ? e.message : String(e)), fix: "check BUNKER_APP_ID / BUNKER_APP_PRIVATE_KEY_PATH (the App must be installed on this repo) or BUNKER_BOT_GH_TOKEN; unset them to use the owner's PAT" });
    }
  }
  const probe = repo && ghEnv.BUNKER_GH_TOKEN ? await probeGhToken(repo, defaultBranch ?? "HEAD", ghEnv) : undefined;
  if (!checks.some((c) => c.id === "identity")) {
    const probeNow = probe;
    add({
      id: "identity",
      group: "auth",
      label: "GitHub identity",
      ok: true,
      required: false,
      detail: `${idDetail}; ${probeNow ? (probeNow.missing.length ? `no access to: ${probeNow.missing.join(", ")}` : "can read the repo, issues and PRs, write per its grants") : "permissions not probed"}`,
    });
  }

  if (!env.BUNKER_GH_TOKEN && kind === "pat") {
    add({ id: "auth-gh", group: "auth", label: "BUNKER_GH_TOKEN set", ok: false, fix: TOKEN_FIX });
  } else if (!repo) {
    add({ id: "auth-gh", group: "auth", label: "BUNKER_GH_TOKEN set", ok: true, detail: "not probed (no GitHub origin)" });
  } else if (!probe) {
    add({ id: "auth-gh", group: "auth", label: "BUNKER_GH_TOKEN set", ok: false, fix: TOKEN_FIX });
  } else {
    add({
      id: "auth-gh",
      group: "auth",
      label: probe!.missing.length ? "BUNKER_GH_TOKEN access" : "BUNKER_GH_TOKEN can read the repo, issues and PRs",
      ok: probe!.missing.length === 0,
      ...(probe!.missing.length ? { detail: `no access to: ${probe!.missing.join(", ")}` } : {}),
      fix: TOKEN_FIX,
    });
  }

  // GitHub
  const ghFix = "needs `gh auth login` and a GitHub origin";
  if (!ghUsable) {
    add({ id: "labels", group: "github", label: "labels", ok: false, fix: ghFix });
  } else {
    const labels = await exec(["gh", "label", "list", "--repo", repo!.slug, "--json", "name", "--limit", "200"], { env: userEnv(env) });
    let names: string[] | undefined;
    try {
      names = (JSON.parse(labels.out) as { name: string }[]).map((l) => l.name);
    } catch {}
    for (const l of LABELS) {
      const old = Object.keys(OLD_LABELS).find((o) => OLD_LABELS[o] === l);
      add({ id: `label-${l}`, group: "github", label: `label ${l}`, ok: !!names?.includes(l), required: !OPTIONAL_LABELS.includes(l), fix: old && names?.includes(old) ? `gh label edit ${old} --name ${l} --repo ${repo!.slug} (keeps it on existing issues)` : `gh label create ${l} --repo ${repo!.slug}` });
    }
    for (const [old, now] of Object.entries(OLD_LABELS)) {
      if (names?.includes(old)) add({ id: `old-label-${old}`, group: "github", label: `old label ${old} (no longer used)`, ok: false, required: false, fix: `gh label edit ${old} --name ${now} --repo ${repo!.slug}` });
    }
    const branch = defaultBranch ?? "main";
    add({
      id: "auto-merge",
      group: "github",
      label: "allow auto-merge",
      ok: repoJson?.allow_auto_merge === true,
      fix: `Settings → General → Pull Requests → "Allow auto-merge" (https://github.com/${repo!.slug}/settings); if the repo is managed by IaC (terraform etc.), change it there`,
    });
    let ci = false;
    try {
      ci = readdirSync(join(root, ".github", "workflows")).some((f) => /\.ya?ml$/.test(f));
    } catch {}
    add({ id: "ci", group: "github", label: "CI workflow", ok: ci, fix: "add a workflow under .github/workflows/ that runs your tests, e.g. on pull_request" });
    const u = userEnv(env);
    // Same check as `bunker --merge`: a ruleset or classic branch protection (read with the user's own gh login, which has the admin access protection needs).
    const gate = await requiredCheck(
      () => exec(["gh", "api", `repos/${repo!.slug}/rules/branches/${branch}`], { env: u }),
      () => exec(["gh", "api", `repos/${repo!.slug}/branches/${branch}/protection/required_status_checks`], { env: u }),
    );
    add({
      id: "required-check",
      group: "github",
      label: `${branch} requires a status check`,
      ok: gate.state === "required",
      fix:
        gate.state === "unreadable"
          ? `could not read the rulesets or branch protection of ${branch} (${gate.detail.slice(0, 160)}); check that your gh login can administer the repo, and that the run's token has Administration: read`
          : `Settings → Rules → Rulesets → new branch ruleset targeting ${branch} → "Require status checks to pass" and pick your CI job (https://github.com/${repo!.slug}/settings/rules), or require one in classic branch protection (Settings → Branches); if the repo is managed by IaC, change it there`,
    });
  }

  // the label-adder check reads collaborator permissions (and the issue's label events) with the scoped token
  if (repo) {
    const e = scopedEnv(env);
    const me = await exec(["gh", "api", "user", "--jq", ".login"], { env: e });
    const login = me.out.trim();
    const perm = me.code === 0 && login ? await exec(["gh", "api", `repos/${repo.slug}/collaborators/${login}/permission`, "--jq", ".role_name"], { env: e }) : undefined;
    add({
      id: "labeler-check",
      group: "github",
      label: "token can look up who may queue work (collaborator permission)",
      ok: perm?.code === 0,
      fix: "bunker only works issues whose `bunker:queued` label a maintainer added, and fails closed when it can't read collaborator permissions; use a token that can (Metadata R, or a classic token with repo access) and a GitHub origin",
    });
  }

  // models
  const models = resolveModels({}, env, cfg?.models);
  add({
    id: "models",
    group: "models",
    label: "models",
    ok: true,
    required: false,
    detail: (["implementer", "reviewer", "auditor"] as const).map((r) => `${r}: ${models[r] ?? DEFAULT_MODEL_LABEL}`).join(", "),
  });

  // skills each role gets (user config + the repo's default branch); a missing or unsafe one fails the check
  try {
    const paths = await skillPaths(root, env);
    for (const role of SKILL_ROLES) {
      try {
        const names = resolveSkills(paths[role], env.HOME).map((k) => k.name);
        add({ id: `skills-${role}`, group: "config", label: `skills (${role})`, ok: true, required: false, detail: names.length ? names.join(", ") : "none" });
      } catch (e) {
        if (!(e instanceof SkillError)) throw e;
        add({ id: `skills-${role}`, group: "config", label: `skills (${role})`, ok: false, detail: e.message, fix: "fix the path in skills (config.toml), or remove it" });
      }
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    add({ id: "skills", group: "config", label: "skills", ok: false, detail: e.message, fix: "fix the skills key named above" });
  }

  // removed user config keys (kebab-case, now snake_case)
  const userKeys = await readUserConfigRaw(env).catch(() => ({}));
  for (const k of removedUserKeys(userKeys)) add({ id: "config-removed-key", group: "config", label: "removed config key", ok: false, required: false, detail: `${k.old} in ${userConfigPath(env)}`, fix: `rename ${k.old} to ${k.new}` });

  // spend (notional USD logged by bunker watch)
  // The cap watch uses without flags: the repo's [watch] caps over the user-level ones (#482).
  const fileCaps = await loadSpendCaps(env).catch(() => ({}));
  const watchCaps = cfg?.watch ?? {};
  const sources = capSources(watchCaps, fileCaps);
  const where = (w: "day" | "month") => (sources[w] === "repo" ? ".bunker/config.toml" : sources[w] === "user" ? userConfigPath(env) : undefined);
  const from = (["day", "month"] as const).flatMap((w) => (where(w) ? [`${w} cap from ${where(w)}`] : []));
  add({ id: "spend", group: "spend", label: "spend so far", ok: true, required: false, detail: formatSpend(join(cwd, ".bunker", "watch-spend.json"), capsFrom(watchCaps, fileCaps)) + (from.length ? ` (${from.join(", ")}; --max-cost-day/--max-cost-month override)` : "") });

  // storage under .bunker/ that pruning keeps in check
  for (const dir of ["runs", "sessions"]) add({ id: `${dir}-size`, group: "repo", label: `.bunker/${dir}/ size`, ok: true, required: false, detail: formatBytes(dirSize(join(cwd, ".bunker", dir))) });

  return { checks, code: checks.some((c) => c.required && !c.ok) ? 1 : 0, ...(repo ? { repo } : {}), ...(defaultBranch ? { defaultBranch } : {}) };
}

const TITLES: Record<Check["group"], string> = { tools: "Tools", auth: "Auth", repo: "Repo", config: "Config", github: "GitHub", models: "Models", spend: "Watch spend" };

export function formatChecks(all: Check[]): string {
  const order = Object.keys(TITLES);
  const checks = [...all].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const lines: string[] = [];
  let group: string | undefined;
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      lines.push(TITLES[c.group]);
    }
    const mark = c.ok ? "✓" : c.required ? "✗" : "·";
    lines.push(`  ${mark} ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
    if (!c.ok && c.fix) lines.push(`      fix: ${c.fix}`);
  }
  return redact(lines.join("\n"));
}
