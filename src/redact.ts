/** Env vars whose values must never appear in output. */
const SECRET_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "BUNKER_GH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const TOKEN_SHAPES = /github_pat_\w+|gh[po]_[A-Za-z0-9]{10,}|sk-ant-[\w-]+/g;

/** Replaces known secret values and token-shaped strings with [REDACTED]. */
export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  // Longest first so a value that contains another is fully covered.
  const values = [...SECRET_VARS.map((k) => env[k]).filter((v): v is string => !!v), ...extra].sort((a, b) => b.length - a.length);
  for (const v of values) out = out.replaceAll(v, "[REDACTED]");
  return out.replace(TOKEN_SHAPES, "[REDACTED]");
}

const extra = new Set<string>();

/** Registers more values (e.g. from copied .env files) to redact for the rest of this process. Values under 4 characters are ignored. */
export function addSecrets(values: string[]): void {
  for (const v of values) if (v.length >= 4) extra.add(v);
}

const ZWJ = "‍";
const CLOSING_REF = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?=:?\s+(?:#\d+|GH-\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+))/gi;

/** Redacts secrets and defuses what GitHub would act on in agent-written text: closing keywords (`Fixes #12`) and `@mentions`. */
export function neutralise(text: string): string {
  return redact(text)
    .replace(CLOSING_REF, `$1${ZWJ}`)
    .replace(/@(?=[\w-])/g, `@${ZWJ}`);
}

/** Agent text as an inline code span (neutralised first); fences longer than any backtick run inside. */
export function codeSpan(text: string): string {
  const t = neutralise(text).replace(/\s+/g, " ").trim();
  const fence = "`".repeat(Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${fence} ${t} ${fence}`;
}
