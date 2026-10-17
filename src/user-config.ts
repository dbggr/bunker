import { homedir } from "node:os";
import { join } from "node:path";

/** Where the user-level config lives: `$XDG_CONFIG_HOME/bunker/config.toml`, else `~/.config/bunker/config.toml`. */
export const userConfigPath = (env: Record<string, string | undefined> = process.env): string =>
  join(env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config"), "bunker", "config.toml");

/** The parsed user-level config.toml; `{}` when the file doesn't exist. */
export async function readUserConfig(env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const file = Bun.file(userConfigPath(env));
  if (!(await file.exists())) return {};
  return Bun.TOML.parse(await file.text()) as Record<string, unknown>;
}
