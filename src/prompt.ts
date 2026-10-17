import { $ } from "bun";
import { isolatedEnv } from "./sandboxes/env.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN = /!`([^`]*)`|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface RenderOptions {
  /** Where `!`cmd`` runs: the worktree. */
  cwd: string;
  /** Values for {{KEY}}: built-ins plus caller args. Values are inserted as-is and never expanded. */
  vars: Record<string, string>;
  /** Env for commands; defaults to bunker's isolated env (no GitHub or Claude tokens). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * The template for `name`: `.bunker/prompts/<name>.md` at `rev` (the default branch) if present, else the built-in.
 * Read from a commit, never a worktree, so an agent can't supply the commands a template runs on the host.
 */
export async function loadPromptTemplate(repo: string, rev: string, name: string, builtin: string): Promise<string> {
  if ((await $`git -C ${repo} cat-file -e ${`${rev}^{commit}`}`.nothrow().quiet()).exitCode !== 0) throw new Error(`prompt: cannot read commit ${rev}`);
  const file = await $`git -C ${repo} show ${`${rev}:.bunker/prompts/${name}.md`}`.nothrow().quiet();
  return file.exitCode === 0 ? file.stdout.toString() : builtin;
}

/**
 * Expands a prompt template in one pass: `!`cmd`` becomes the command's output (run on the host in `cwd`) and
 * `{{KEY}}` becomes `vars[KEY]`. Only the template is scanned, so values (issue text) and command output are never
 * re-expanded; commands come from the template alone. An unknown key or a failing command throws.
 */
export async function renderPrompt(template: string, o: RenderOptions): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    parts.push(template.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      parts.push(await runCommand(m[1], o));
    } else {
      const key = m[2]!;
      if (!Object.hasOwn(o.vars, key)) throw new Error(`prompt: unknown key {{${key}}} (known: ${Object.keys(o.vars).join(", ") || "none"})`);
      parts.push(o.vars[key]!);
    }
  }
  parts.push(template.slice(last));
  return parts.join("");
}

async function runCommand(cmd: string, o: RenderOptions): Promise<string> {
  const ms = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = Bun.spawn(["bash", "-c", cmd], { cwd: o.cwd, env: o.env ?? isolatedEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: ms, killSignal: "SIGKILL" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (proc.signalCode) throw new Error(`prompt: command \`${cmd}\` timed out after ${ms}ms`);
  if (code !== 0) throw new Error(`prompt: command \`${cmd}\` failed (exit ${code}): ${err.trim().slice(0, 500)}`);
  return out.replace(/\n+$/, "");
}
