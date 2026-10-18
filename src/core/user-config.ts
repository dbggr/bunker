import { homedir } from "node:os";
import { join } from "node:path";

/** Where the user-level config lives: `$XDG_CONFIG_HOME/bunker/config.toml`, else `~/.config/bunker/config.toml`. */
export const userConfigPath = (env: Record<string, string | undefined> = process.env): string =>
  join(env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config"), "bunker", "config.toml");

/** Kebab-case spellings that are no longer read, with the key to use instead. */
const REMOVED_KEYS: Record<string, string> = {
  "max-cost-day": "max_cost_day",
  "max-cost-month": "max_cost_month",
  "allow-labelers": "allow_labelers",
};

/** Removed spellings present in `parsed`, with the key to use instead. */
export const removedUserKeys = (parsed: Record<string, unknown>): { old: string; new: string }[] =>
  Object.entries(REMOVED_KEYS).filter(([old]) => old in parsed).map(([old, now]) => ({ old, new: now }));

/** The parsed config.toml exactly as written (removed keys included); `{}` when missing. */
export async function readUserConfigRaw(env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const file = Bun.file(userConfigPath(env));
  if (!(await file.exists())) return {};
  return Bun.TOML.parse(await file.text()) as Record<string, unknown>;
}

/** The parsed user-level config.toml; `{}` when the file doesn't exist. Throws if it uses a removed kebab-case key. */
export async function readUserConfig(env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const parsed = await readUserConfigRaw(env);
  const old = removedUserKeys(parsed);
  if (old.length) throw new Error(`${userConfigPath(env)}: ${old.map((k) => `"${k.old}" is no longer read; rename it to "${k.new}"`).join("; ")}`);
  return parsed;
}
