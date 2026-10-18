import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../core/redact.ts";
import { stepLimits, type Sandbox } from "../../sandboxes/exec.ts";
import { exec } from "../commands/doctor.ts";

export interface DryRunResult {
  ok: boolean;
  /** Where it stopped: building or starting the image, `setup`, or `verify`. */
  phase?: "image" | "setup" | "verify";
  /** Last lines of the output. */
  tail: string;
  seconds: number;
}

const tailOf = (text: string, n = 15) => redact(text.trimEnd().split("\n").slice(-n).join("\n"));

/**
 * Runs `setup` then `verify` once in the sandbox, in a throwaway worktree of HEAD, the way an unattended run does:
 * setup with network (it installs), verify isolated (no network, no credentials) unless `network`.
 */
export async function sandboxDryRun(o: { root: string; env: Record<string, string | undefined>; sandbox: Sandbox; setup?: string; verify: string; network?: boolean }): Promise<DryRunResult> {
  const start = Date.now();
  const done = (r: Omit<DryRunResult, "seconds">): DryRunResult => ({ ...r, seconds: Math.round((Date.now() - start) / 1000) });
  const tmp = await mkdtemp(join(tmpdir(), "bunker-init-"));
  const worktree = join(tmp, "worktree");
  const removeSync = () => Bun.spawnSync(["git", "-C", o.root, "worktree", "remove", "--force", worktree], { stdout: "ignore", stderr: "ignore" });
  const onExit = () => removeSync();
  process.on("exit", onExit);
  try {
    const add = await exec(["git", "-C", o.root, "worktree", "add", "--detach", worktree, "HEAD"], { env: o.env });
    if (add.code !== 0) return done({ ok: false, phase: "image", tail: `could not make a scratch worktree (does the repo have a commit yet?): ${add.err.trim()}` });
    // the Dockerfile may be new and uncommitted: the real run builds from the checkout, so give the scratch copy the same file
    const dockerfile = join(o.root, ".bunker", "Dockerfile");
    if (existsSync(dockerfile)) {
      mkdirSync(join(worktree, ".bunker"), { recursive: true });
      copyFileSync(dockerfile, join(worktree, ".bunker", "Dockerfile"));
    }
    const common = await exec(["git", "-C", o.root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { env: o.env });
    const ctx = { worktree, gitCommonDir: common.out.trim(), limits: stepLimits({}) };
    try {
      if (o.setup) {
        const s = await o.sandbox.exec(["sh", "-c", `(${o.setup}) 2>&1`], ctx);
        if (s.code !== 0 || s.timedOut) return done({ ok: false, phase: "setup", tail: tailOf(s.stdout + (s.timedOut ? `\n(timed out: ${s.timedOut})` : "")) });
      }
      const v = await o.sandbox.exec(["sh", "-c", `(${o.verify}) 2>&1`], { ...ctx, isolate: !o.network });
      if (v.code !== 0 || v.timedOut) return done({ ok: false, phase: "verify", tail: tailOf(v.stdout + (v.timedOut ? `\n(timed out: ${v.timedOut})` : "")) });
      return done({ ok: true, tail: tailOf(v.stdout, 5) });
    } catch (e) {
      return done({ ok: false, phase: "image", tail: redact(e instanceof Error ? e.message : String(e)) });
    }
  } finally {
    process.off("exit", onExit);
    removeSync();
    await rm(tmp, { recursive: true, force: true });
  }
}
