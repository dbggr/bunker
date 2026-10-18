import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../core/redact.ts";
import { exec, userEnv, type Exec } from "../commands/doctor.ts";
import { ciWorkflow, type Toolchain } from "./toolchain.ts";

type Env = Record<string, string | undefined>;

export const CI_JOB = "test";
export const CI_FILE = ".github/workflows/ci.yml";

/** Which IaC tool seems to manage the repo's settings, if any: a UI or API edit there would be reverted. */
export function iacTool(root: string): string | undefined {
  if (existsSync(join(root, ".github", "settings.yml")) || existsSync(join(root, ".github", "settings.yaml"))) return "probot settings (.github/settings.yml)";
  for (const dir of [".", "terraform", "infra", "infrastructure", "tf"]) {
    try {
      for (const f of readdirSync(join(root, dir))) {
        if (f.endsWith(".tf") && /github_(repository|branch_protection|repository_ruleset)/.test(readFileSync(join(root, dir, f), "utf8"))) return `terraform (${dir === "." ? f : `${dir}/${f}`})`;
      }
    } catch {}
  }
  return undefined;
}

/** A branch ruleset on the default branch that requires the `test` check. */
export const rulesetBody = (check = CI_JOB) => ({
  name: `bunker: require ${check}`,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: check }] } }],
});

/** Creates the ruleset through the user's own gh login (the scoped token can't administer the repo). */
export async function createRuleset(slug: string, env: Env): Promise<Exec> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-ruleset-"));
  try {
    const file = join(dir, "ruleset.json");
    await writeFile(file, JSON.stringify(rulesetBody()));
    return await exec(["gh", "api", `repos/${slug}/rulesets`, "--method", "POST", "--input", file], { env: userEnv(env) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Why a settings write failed, in a sentence. */
export function whyDenied(r: Exec): string {
  const text = redact(`${r.err} ${r.out}`.trim());
  return /403|forbidden|admin|must have|not accessible/i.test(text) ? `your gh login can't administer this repo (${text.slice(0, 160)})` : text.slice(0, 200) || `gh exited ${r.code}`;
}

/**
 * Commits the CI workflow on a new branch in a scratch worktree and opens a PR: never touches the default branch
 * or the user's checkout. Uses the user's own git and gh credentials (the scoped token can't push workflows).
 */
export async function openCiPr(o: { root: string; slug: string; base: string; tc: Toolchain; env: Env }): Promise<{ url?: string; branch: string; error?: string }> {
  const env = userEnv(o.env);
  const taken = (await exec(["git", "-C", o.root, "rev-parse", "--verify", "-q", "refs/heads/bunker/init-ci"], { env })).code === 0;
  const branch = taken ? `bunker/init-ci-${Date.now().toString(36)}` : "bunker/init-ci";
  const tmp = await mkdtemp(join(tmpdir(), "bunker-ci-"));
  const wt = join(tmp, "worktree");
  try {
    const hasRemote = (await exec(["git", "-C", o.root, "rev-parse", "--verify", "-q", `refs/remotes/origin/${o.base}`], { env })).code === 0;
    const add = await exec(["git", "-C", o.root, "worktree", "add", "-b", branch, wt, hasRemote ? `origin/${o.base}` : "HEAD"], { env });
    if (add.code !== 0) return { branch, error: `could not make a scratch worktree: ${add.err.trim()}` };
    await Bun.write(join(wt, CI_FILE), ciWorkflow(o.tc, o.base));
    for (const cmd of [
      ["git", "-C", wt, "add", CI_FILE],
      ["git", "-C", wt, "commit", "-q", "-m", "ci: add a test workflow (bunker init)"],
      ["git", "-C", wt, "push", "-q", "-u", "origin", branch],
    ]) {
      const r = await exec(cmd, { env });
      if (r.code !== 0) return { branch, error: `${cmd.slice(2, 4).join(" ")} failed: ${redact(r.err.trim())}` };
    }
    const pr = await exec(["gh", "pr", "create", "--repo", o.slug, "--base", o.base, "--head", branch, "--title", "ci: add a test workflow (bunker init)", "--body", `Adds \`${CI_FILE}\` with a job named \`${CI_JOB}\` that runs the setup and verify commands from \`.bunker/config.toml\`. bunker merges only when this check passes. Opened by \`bunker init\`.`], { env });
    if (pr.code !== 0) return { branch, error: `gh pr create failed: ${redact(pr.err.trim())}` };
    return { branch, url: pr.out.trim().split("\n").pop() };
  } finally {
    await exec(["git", "-C", o.root, "worktree", "remove", "--force", wt], { env });
    await exec(["git", "-C", o.root, "branch", "-D", branch], { env });
    await rm(tmp, { recursive: true, force: true });
  }
}
