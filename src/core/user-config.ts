import { homedir } from "node:os";
import { join } from "node:path";

/** Where the user-level config lives: `$XDG_CONFIG_HOME/bunker/config.toml`, else `~/.config/bunker/config.toml`. */
export const userConfigPath = (env: Record<string, string | undefined> = process.env): string =>
  join(env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config"), "bunker", "config.toml");

/** Pre-1.0 kebab-case spellings, still read for one release. */
const DEPRECATED_KEYS: Record<string, string> = {
  "max-cost-day": "max_cost_day",
  "max-cost-month": "max_cost_month",
  "allow-labelers": "allow_labelers",
};

/** Deprecated spellings present in `parsed`, with the key to use instead. */
export const deprecatedUserKeys = (parsed: Record<string, unknown>): { old: string; new: string }[] =>
  Object.entries(DEPRECATED_KEYS).filter(([old]) => old in parsed).map(([old, now]) => ({ old, new: now }));

const warned = new Set<string>();
/** Default warner: stderr, once per message per process. */
const warnOnce = (message: string): void => {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(message);
};

/** The parsed config.toml exactly as written (deprecated keys included); `{}` when missing. */
export async function readUserConfigRaw(env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const file = Bun.file(userConfigPath(env));
  if (!(await file.exists())) return {};
  return Bun.TOML.parse(await file.text()) as Record<string, unknown>;
}

/**
 * The parsed user-level config.toml; `{}` when the file doesn't exist. Deprecated kebab-case keys are renamed
 * to snake_case (the snake_case spelling wins if both are set) and `warn` is called for each.
 */
export async function readUserConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = warnOnce,
): Promise<Record<string, unknown>> {
  const parsed = await readUserConfigRaw(env);
  for (const { old, new: now } of deprecatedUserKeys(parsed)) {
    if (!(now in parsed)) parsed[now] = parsed[old];
    delete parsed[old];
    warn(`bunker: config.toml: "${old}" is deprecated and stops working after the next release; rename it to "${now}"`);
  }
  return parsed;
}
