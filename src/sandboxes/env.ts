import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { output } from "../core/output.ts";
import { CLAUDE_CREDENTIAL_VARS } from "../agents/claude.ts";

/** GitHub credentials bunker itself uses; an agent must never see them. */
export const GH_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "BUNKER_GH_TOKEN", "BUNKER_BOT_GH_TOKEN", "BUNKER_APP_ID", "BUNKER_APP_PRIVATE_KEY_PATH"] as const;

export function agentEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const name of GH_TOKEN_VARS) delete env[name];
  return env;
}

/** Env for running agent-written code on the host (verify): no GitHub tokens, no Claude credentials. */
export function isolatedEnv(): Record<string, string | undefined> {
  const env = agentEnv();
  for (const name of CLAUDE_CREDENTIAL_VARS) delete env[name];
  return env;
}

/** Spawns a verify command on the host in its own process group, with an isolated env and a throwaway empty HOME (no ~/.config/gh, ~/.claude, ~/.ssh). */
export function spawnOnHost(verify: string, cwd: string) {
  output.warn("bunker: --verify-on-host gives agent-written tests no isolation from the host (they only get an empty HOME; they still run as you and can read and write any file you can)");
  const home = mkdtempSync(join(tmpdir(), "bunker-verify-home-"));
  const env: Record<string, string | undefined> = { ...isolatedEnv(), HOME: home, BUNKER_IN_SANDBOX: "1" };
  delete env.XDG_CONFIG_HOME;
  // Own process group (setsid) so a timeout kills the whole tree, not just the shell.
  const proc = Bun.spawn(["setsid", "sh", "-c", verify], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { proc, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
