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
