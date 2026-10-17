import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { formatSpend, loadSpendCaps } from "./spend.ts";
import { AUTH_VARS, loadBunkerEnv } from "./env.ts";
import { DEFAULT_MODEL_LABEL, resolveModels } from "./models.ts";
import { ConfigError, effectiveSettings, formatValue, loadRepoConfig } from "./config.ts";
import { redact } from "./redact.ts";
import { PRIORITY_LABELS } from "./priority.ts";

type Env = Record<string, string | undefined>;

/** Filed on follow-ups and audit findings; filing falls back to no severity label without them, so they are optional. */
export const SEVERITY_LABELS = ["severity:high", "severity:medium"] as const;
export const LABELS = ["bunker", "discovered", "bunker-failed", "bunker-blocked", ...PRIORITY_LABELS.map((p) => p.name), ...SEVERITY_LABELS] as const;

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
  "create a fine-grained token for this one repo with Contents RW, Pull requests RW, Issues RW, Metadata R (nothing else) at https://github.com/settings/personal-access-tokens/new, then set BUNKER_GH_TOKEN in ~/.config/bunker/.env (`bunker init` does this)";

export async function runDoctor(opts: { cwd: string; env?: Env }): Promise<{ checks: Check[]; code: number; repo?: RepoInfo; defaultBranch?: string }> {
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
    loaded = await loadRepoConfig(root);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    add({ id: "config", group: "config", label: ".bunker/config.toml", ok: false, detail: e.message, fix: "fix the key named above (see `bunker --help`, Repo config)" });
  }
  const cfg = loaded?.config;
  const legacy = loaded?.legacy ?? {};
  if (loaded?.present) add({ id: "config", group: "config", label: ".bunker/config.toml", ok: true, detail: loaded.warnings.length ? loaded.warnings.join("; ") : "valid" });
  for (const n of loaded?.notes ?? []) add({ id: "config-legacy", group: "config", label: "legacy files", ok: false, required: false, detail: n.replace(/^bunker: /, ""), fix: "move those settings into .bunker/config.toml and delete the files" });
  if (loaded) for (const s of effectiveSettings({ config: loaded.config, legacy: loaded.legacy, env })) add({ id: `setting-${s.key}`, group: "config", label: s.key, ok: true, required: false, detail: `${formatValue(s.value)} (${s.source})` });
  add({ id: "verify", group: "repo", label: "verify command", ok: !!cfg?.verify || !!legacy.verify, fix: "set verify in .bunker/config.toml with the command that must pass before pushing, e.g. `bun test && bun run typecheck` (`bunker init` proposes one)" });
  add({ id: "setup", group: "repo", label: "setup command (optional)", ok: !!cfg?.setup || !!legacy.setup, required: false, fix: "runs in each worktree before the agent, e.g. `bun install --frozen-lockfile`" });
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

  if (!env.BUNKER_GH_TOKEN) {
    add({ id: "auth-gh", group: "auth", label: "BUNKER_GH_TOKEN set", ok: false, fix: TOKEN_FIX });
  } else if (!repo) {
    add({ id: "auth-gh", group: "auth", label: "BUNKER_GH_TOKEN set", ok: true, detail: "not probed (no GitHub origin)" });
  } else {
    const probe = await probeGhToken(repo, defaultBranch ?? "HEAD", env);
    add({
      id: "auth-gh",
      group: "auth",
      label: probe.missing.length ? "BUNKER_GH_TOKEN access" : "BUNKER_GH_TOKEN can read the repo, issues and PRs",
      ok: probe.missing.length === 0,
      ...(probe.missing.length ? { detail: `no access to: ${probe.missing.join(", ")}` } : {}),
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
      add({ id: `label-${l}`, group: "github", label: `label ${l}`, ok: !!names?.includes(l), required: !(SEVERITY_LABELS as readonly string[]).includes(l), fix: `gh label create ${l} --repo ${repo!.slug}` });
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
    const [prot, rules] = await Promise.all([
      exec(["gh", "api", `repos/${repo!.slug}/branches/${branch}/protection/required_status_checks`], { env: u }),
      exec(["gh", "api", `repos/${repo!.slug}/rules/branches/${branch}`], { env: u }),
    ]);
    let required = false;
    try {
      const p = JSON.parse(prot.out);
      required = prot.code === 0 && ((p.contexts?.length ?? 0) > 0 || (p.checks?.length ?? 0) > 0);
    } catch {}
    try {
      const r = JSON.parse(rules.out) as { type: string }[];
      if (rules.code === 0 && r.some((x) => x.type === "required_status_checks")) required = true;
    } catch {}
    add({
      id: "required-check",
      group: "github",
      label: `${branch} requires a status check`,
      ok: required,
      fix: `Settings → Branches → protect ${branch} → "Require status checks to pass" and pick your CI job (https://github.com/${repo!.slug}/settings/branches); if the repo is managed by IaC, change it there`,
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
      fix: "bunker only works issues whose `bunker` label a maintainer added, and fails closed when it can't read collaborator permissions; use a token that can (Metadata R, or a classic token with repo access) and a GitHub origin",
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

  // spend (notional USD logged by --watch)
  const caps = await loadSpendCaps(env).catch(() => ({}));
  add({ id: "spend", group: "spend", label: "spend so far", ok: true, required: false, detail: formatSpend(join(cwd, ".bunker", "watch-spend.json"), caps) });

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
