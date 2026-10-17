import { $ } from "bun";
import { redact } from "./redact.ts";

/**
 * Shows a desktop notification with `notify-send` (Linux) or `osascript` (macOS). Silently does nothing when neither
 * is installed or the command fails. The text is redacted first.
 */
export async function desktopNotify(title: string, body: string): Promise<void> {
  const t = redact(title);
  const b = redact(body);
  const path = process.env.PATH;
  try {
    if (Bun.which("notify-send", { PATH: path })) {
      await $`notify-send ${"--"} ${t} ${b}`.nothrow().quiet();
    } else if (process.platform === "darwin" && Bun.which("osascript", { PATH: path })) {
      // Arguments, not string interpolation, so no text can escape into the script.
      await $`osascript -e ${"on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run"} ${t} ${b}`.nothrow().quiet();
    }
  } catch {}
}

/** The repo owner's login when the owner is a user account (not an organisation); undefined if gh can't say. */
export async function ownerLogin(cwd: string, env: Record<string, string>): Promise<string | undefined> {
  const r = await $`gh api repos/{owner}/{repo} --jq ${'"\\(.owner.type) \\(.owner.login)"'}`.cwd(cwd).env(env).nothrow().quiet();
  if (r.exitCode !== 0) return undefined;
  const m = /^User (\S+)$/.exec(r.stdout.toString().trim());
  return m?.[1];
}
