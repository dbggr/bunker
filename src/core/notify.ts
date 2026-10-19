import { $ } from "bun";
import { redact } from "./redact.ts";

type Env = Record<string, string>;

/** Tells the user something needs them. Fire and forget: never throws, never waits. */
export type Notify = (title: string, body: string) => void;

export const noNotify: Notify = () => {};

/** Names the repo in every title (`bunker: x` becomes `bunker · repo: x`), so notifications from several watches are told apart. */
export function withRepo(notify: Notify, repo: string): Notify {
  return (title, body) => notify(title.startsWith("bunker:") ? `bunker · ${repo}:${title.slice("bunker:".length)}` : `bunker · ${repo}: ${title}`, body);
}

const osaQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Desktop notifications via `notify-send` (Linux) or `osascript` (macOS), when present;
 * silently does nothing otherwise. Title and body are redacted.
 */
export function desktopNotifier(o: { enabled?: boolean; platform?: string; path?: string } = {}): Notify {
  if (o.enabled === false) return noNotify;
  const platform = o.platform ?? process.platform;
  const bin = platform === "darwin" ? "osascript" : platform === "linux" ? "notify-send" : undefined;
  const exe = bin ? Bun.which(bin, o.path === undefined ? {} : { PATH: o.path }) : null;
  if (!exe) return noNotify;
  return (title, body) => {
    const t = redact(title);
    const b = redact(body);
    const args = bin === "osascript" ? ["-e", `display notification ${osaQuote(b)} with title ${osaQuote(t)}`] : ["--app-name=bunker", t, b];
    try {
      Bun.spawn([exe, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    } catch {}
  };
}

/**
 * The `@login` bunker puts in failed/blocked comments so GitHub notifies the user: the configured
 * login, else the repo owner when it's a user account (an org owner can't be notified that way).
 * "" when nothing applies or gh can't say.
 */
export async function resolveMention(cwd: string, env: Env, configured?: string): Promise<string> {
  if (configured) return `@${configured.replace(/^@/, "")}`;
  const owner = await $`gh repo view --json owner --jq .owner.login`.cwd(cwd).env(env).nothrow().quiet();
  const login = owner.exitCode === 0 ? owner.stdout.toString().trim() : "";
  if (!login) return "";
  const type = await $`gh api users/${login} --jq .type`.cwd(cwd).env(env).nothrow().quiet();
  return type.exitCode === 0 && type.stdout.toString().trim() === "User" ? `@${login}` : "";
}
