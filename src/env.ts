type Env = Record<string, string | undefined>;

export const AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

export const AUTH_HINT = `bunker: no Claude auth found.
  Run \`claude setup-token\` and put the token in .bunker/.env:
    CLAUDE_CODE_OAUTH_TOKEN=<token>
  (or export it, or set ANTHROPIC_API_KEY to bill an API key instead). See .env.example.`;

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
