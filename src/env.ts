import { join } from "node:path";

type Env = Record<string, string | undefined>;

export const AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

export const AUTH_HINT = `bunker: no Claude auth found.
  Run \`claude setup-token\` and put the token in ~/.config/bunker/.env:
    CLAUDE_CODE_OAUTH_TOKEN=<token>
  (a repo's .bunker/.env or an exported var overrides it; ANTHROPIC_API_KEY bills an API key instead). See .env.example.`;

/** Loads auth/config env. Precedence: already-set vars > <repo>/.bunker/.env > user file. */
export async function loadBunkerEnv(cwd: string, env: Env = process.env): Promise<void> {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME ?? "", ".config");
  // loadEnvFile never overwrites, so the first file loaded wins.
  await loadEnvFile(join(cwd, ".bunker", ".env"), env);
  await loadEnvFile(join(configHome, "bunker", ".env"), env);
}

/** Loads KEY=VALUE lines into env. `#` lines are comments; variables already set win. */
export async function loadEnvFile(path: string, env: Env = process.env): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  for (const raw of (await file.text()).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

export function hasAuth(env: Env = process.env): boolean {
  return AUTH_VARS.some((name) => !!env[name]);
}
