import { $ } from "bun";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { output } from "../core/output.ts";
import { CLAUDE_AUTH_FILES } from "../agents/claude.ts";
import { guardGit } from "./git-guard.ts";
import { teeStdout, type Sandbox } from "./exec.ts";
import { agentEnv, isolatedEnv } from "./env.ts";
import type { RoleSkills, SkillRole } from "../core/skills.ts";

/**
 * Runs the agent straight on the host, in the worktree, with a temporary empty HOME (only claude's login copied in) so it
 * can't read ~/.config/bunker/.env, ~/.config/gh or ~/.ssh. Still no isolation from the rest of the host: same user, same filesystem and network.
 */
export function noSandbox(opts: { skills?: RoleSkills } = {}): Sandbox {
  // One temp HOME per role: each gets only its own skills linked in.
  const homes = new Map<string, { dir: string; real: string | undefined }>();
  let storeDir = "";
  let warned = false;
  const tempHome = (role?: SkillRole) => {
    // Read late: a different real HOME (tests) gets its own temp HOME and store.
    const key = role ?? "";
    const known = homes.get(key);
    if (known && known.real === process.env.HOME) return known.dir;
    if (!warned) output.warn("bunker: --no-sandbox gives the agent no isolation from the host (it only gets an empty HOME; it still runs as you and can read and write any file you can)");
    warned = true;
    const dir = mkdtempSync(join(tmpdir(), "bunker-home-"));
    homes.set(key, { dir, real: process.env.HOME });
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    // Session files outlive the run (a usage-limit pause is resumed by a later process): keep them in a stable dir, linked into the temp HOME.
    const real = process.env.HOME;
    const store = join(real ?? tmpdir(), ".cache", "bunker", "no-sandbox-projects");
    mkdirSync(store, { recursive: true });
    mkdirSync(join(dir, ".claude"), { recursive: true });
    symlinkSync(store, join(dir, ".claude", "projects"));
    storeDir = store;
    // Symlinks can't be read-only: with --no-sandbox the agent could write through them (it can write anywhere you can anyway).
    const skills = role ? opts.skills?.[role] ?? [] : [];
    if (skills.length) {
      mkdirSync(join(dir, ".claude", "skills"));
      for (const k of skills) symlinkSync(k.path, join(dir, ".claude", "skills", k.name));
    }
    if (real) {
      for (const f of CLAUDE_AUTH_FILES) {
        try {
          copyFileSync(join(real, f), join(dir, f));
        } catch {}
      }
    }
    return dir;
  };
  return {
    get projectsDir() {
      tempHome();
      return storeDir;
    },
    exec: async (cmd, { worktree, gitCommonDir, prefix, onLine, limits, isolate, stdin, role }) => {
      const dir = tempHome(role);
      // The real ~/.gitconfig isn't visible any more, so carry the commit identity over.
      const name = (await $`git -C ${worktree} config user.name`.nothrow().quiet().text()).trim();
      const email = (await $`git -C ${worktree} config user.email`.nothrow().quiet().text()).trim();
      const identity: Record<string, string> = {
        ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
        ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
      };
      const env: Record<string, string | undefined> = { ...(isolate ? isolatedEnv() : agentEnv()), ...identity, HOME: dir };
      delete env.XDG_CONFIG_HOME;
      return guardGit(worktree, gitCommonDir, () =>
        // detached: own process group, so a terminal Ctrl-C reaches only bunker, which lets the step finish.
        // Explicit env: Bun.spawn otherwise passes the startup environment, dropping
        // anything set at runtime (e.g. the token loaded from .bunker/.env).
        teeStdout(Bun.spawn(cmd, { cwd: worktree, env, stdio: [stdin === undefined ? "ignore" : new Blob([stdin]), "pipe", "inherit"], detached: true }), prefix, onLine, limits),
      );
    },
  };
}
