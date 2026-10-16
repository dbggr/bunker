/** Env vars whose values must never appear in output. */
const SECRET_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "BUNKER_GH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const TOKEN_SHAPES = /github_pat_\w+|gh[po]_[A-Za-z0-9]{10,}|sk-ant-[\w-]+/g;

/** Replaces known secret values and token-shaped strings with [REDACTED]. */
export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  // Longest first so a value that contains another is fully covered.
  const values = SECRET_VARS.map((k) => env[k]).filter((v): v is string => !!v).sort((a, b) => b.length - a.length);
  for (const v of values) out = out.replaceAll(v, "[REDACTED]");
  return out.replace(TOKEN_SHAPES, "[REDACTED]");
}
