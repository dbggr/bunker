import { $ } from "bun";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
import { parseConfig, parseSkills, type SkillsConfig } from "./config.ts";
import { readUserConfigRaw } from "./user-config.ts";

type Env = Record<string, string | undefined>;

export type SkillRole = "implementer" | "reviewer";
export const SKILL_ROLES: readonly SkillRole[] = ["implementer", "reviewer"];

/** A skill directory, resolved to its real path on the host. `name` is the directory name it gets under `~/.claude/skills/`. */
export interface ResolvedSkill {
  name: string;
  path: string;
}

export type RoleSkills = Partial<Record<SkillRole, ResolvedSkill[]>>;

/** A skill that is missing, not a directory, or reaches outside its own directory. */
export class SkillError extends Error {}

/** The skill paths each role gets: the user's list first, then the repo's; each source's `default` goes to both roles. */
export function skillsForRoles(...sources: SkillsConfig[]): Record<SkillRole, string[]> {
  const out: Record<SkillRole, string[]> = { implementer: [], reviewer: [] };
  for (const role of SKILL_ROLES) out[role] = [...new Set(sources.flatMap((s) => [...(s.default ?? []), ...(s[role] ?? [])]))];
  return out;
}

/** Every entry under `dir` must resolve to somewhere inside `root`. */
function assertContained(root: string, dir: string, shown: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw new SkillError(`skill ${shown}: ${p} is a broken symlink`);
    }
    const rel = relative(root, real);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new SkillError(`skill ${shown}: ${p} points outside the skill directory (${real})`);
    // A symlink that stays inside is checked at its real location; only real directories are descended into (no cycles).
    if (e.isDirectory()) assertContained(root, p, shown);
  }
}

/** Resolves skill paths (`~` is `home`): each must be an existing directory whose contents stay inside it. Throws a SkillError naming the path. */
export function resolveSkills(paths: string[], home: string = homedir()): ResolvedSkill[] {
  const out: ResolvedSkill[] = [];
  for (const shown of paths) {
    const expanded = shown === "~" ? home : shown.startsWith("~/") ? join(home, shown.slice(2)) : shown;
    let real: string;
    try {
      real = realpathSync(expanded);
    } catch {
      throw new SkillError(`skill ${shown} not found`);
    }
    if (!statSync(real).isDirectory()) throw new SkillError(`skill ${shown} is not a directory`);
    const name = basename(real);
    if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") throw new SkillError(`skill ${shown}: directory name "${name}" is not usable (letters, digits, . _ - only)`);
    if (out.some((s) => s.name === name)) throw new SkillError(`skill ${shown}: another listed skill is also named "${name}"`);
    assertContained(real, real, shown);
    out.push({ name, path: real });
  }
  return out;
}

/** The repo's `skills`, read from the default branch's `.bunker/config.toml` (what an agent's branch holds is never used). */
async function repoSkills(repo: string): Promise<SkillsConfig> {
  for (const rev of ["origin/HEAD", "HEAD"]) {
    const f = await $`git -C ${repo} show ${`${rev}:.bunker/config.toml`}`.nothrow().quiet();
    if (f.exitCode === 0) return parseConfig(f.stdout.toString()).config.skills;
  }
  return {};
}

/** The skill paths per role from ~/.config/bunker/config.toml and the repo's default branch. */
export async function skillPaths(repo: string, env: Env = process.env): Promise<Record<SkillRole, string[]>> {
  const raw = await readUserConfigRaw(env).catch(() => ({}));
  const user = parseSkills((raw as Record<string, unknown>).skills, "config.toml");
  return skillsForRoles(user, await repoSkills(repo));
}

/** Resolved skills per role for `repo`. Throws a SkillError when one is missing or unsafe. */
export async function loadSkills(repo: string, env: Env = process.env): Promise<Record<SkillRole, ResolvedSkill[]>> {
  const paths = await skillPaths(repo, env);
  const home = env.HOME ?? homedir();
  return { implementer: resolveSkills(paths.implementer, home), reviewer: resolveSkills(paths.reviewer, home) };
}
