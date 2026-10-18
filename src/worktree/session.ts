import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redact } from "../core/redact.ts";
import type { Sandbox } from "../sandboxes/exec.ts";

export interface Session {
  id: string;
  /** Saved copy on the host. */
  file: string;
}

/** Saves session `id` from the sandbox's store to `dest`, plus a redacted copy next to it. */
export async function captureSession(sandbox: Sandbox, id: string, dest: string): Promise<Session | undefined> {
  const root = sandbox.projectsDir;
  if (!root) return undefined;
  try {
    for (const dir of await readdir(root)) {
      const file = Bun.file(join(root, dir, `${id}.jsonl`));
      if (!(await file.exists())) continue;
      const text = await file.text();
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      // Transcripts can hold secrets the agent saw: owner-only.
      await writeFile(dest, text, { mode: 0o600 });
      await writeFile(dest.replace(/\.jsonl$/, ".redacted.jsonl"), redact(text), { mode: 0o600 });
      return { id, file: dest };
    }
  } catch {}
  return undefined;
}

/** Puts a saved session back where claude (running in `worktree`) looks for it. */
export async function restoreSession(sandbox: Sandbox, worktree: string, session: Session): Promise<void> {
  const root = sandbox.projectsDir;
  if (!root) throw new Error("sandbox has no session store");
  const dir = join(root, worktree.replace(/[^a-zA-Z0-9]/g, "-"));
  const target = join(dir, `${session.id}.jsonl`);
  if (await Bun.file(target).exists()) return;
  await mkdir(dir, { recursive: true });
  await Bun.write(target, Bun.file(session.file));
}

/** Keeps sessions in `dir`, or in a temp dir that `done()` removes. */
export async function sessionStore(dir?: string): Promise<{ dir: string; done: () => Promise<void> }> {
  if (dir) return { dir, done: async () => {} };
  const tmp = await mkdtemp(join(tmpdir(), "bunker-sessions-"));
  return { dir: tmp, done: () => rm(tmp, { recursive: true, force: true }) };
}
