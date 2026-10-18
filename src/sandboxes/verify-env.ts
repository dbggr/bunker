import { tailLines } from "../core/output.ts";
import type { ServiceSet, Services } from "./services.ts";
import { stepLimits, timeoutMessage, type Sandbox, type Timeouts } from "./exec.ts";

/** Services or prepare could not be brought up; `message` says why, `output` is what prepare printed. */
export class VerifyEnvError extends Error {
  constructor(message: string, readonly output = "", readonly timedOut = false) {
    super(message);
  }
}

export interface VerifyEnv {
  /** Container network of the started services, for verify to join; undefined without services. */
  network?: string;
  /** Removes the services again. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Starts the declared `services` and runs `prepare` against them, the way an issue run's verify does.
 * Throws VerifyEnvError (services already removed) when that can't be done; otherwise the caller runs verify
 * with `network` and calls `stop()` afterwards.
 */
export async function startVerifyEnv(
  sandbox: Sandbox,
  o: { services?: Services; prepare?: string; verifyOnHost?: boolean; verifyNetwork?: boolean; worktree: string; gitCommonDir: string; timeouts?: Timeouts; onNote?: (text: string) => void },
): Promise<VerifyEnv> {
  const services = o.services && Object.keys(o.services).length ? o.services : undefined;
  if (!services && !o.prepare) return { stop: async () => {} };
  if (o.verifyOnHost) throw new VerifyEnvError("services and prepare need the sandbox: they can't be combined with --verify-on-host");
  if (services && !sandbox.startServices) throw new VerifyEnvError("services need the docker or podman sandbox (not --no-sandbox)");
  let set: ServiceSet | undefined;
  try {
    if (services) {
      o.onNote?.(`starting services: ${Object.keys(services).join(", ")}`);
      try {
        set = await sandbox.startServices!(services);
      } catch (e) {
        throw new VerifyEnvError(e instanceof Error ? e.message : String(e));
      }
    }
    if (o.prepare) {
      const timeouts = o.timeouts ?? {};
      const out = await sandbox.exec(["sh", "-c", `(${o.prepare}) 2>&1`], { worktree: o.worktree, gitCommonDir: o.gitCommonDir, limits: stepLimits(timeouts), isolate: !o.verifyNetwork, ...(set ? { network: set.network } : {}) });
      if (out.timedOut) throw new VerifyEnvError(timeoutMessage("prepare", out.timedOut, timeouts), out.stdout, true);
      if (out.code !== 0) throw new VerifyEnvError(`prepare failed (exit ${out.code}):\n${tailLines(out.stdout)}`, out.stdout);
    }
  } catch (e) {
    await set?.stop();
    throw e;
  }
  return { ...(set ? { network: set.network } : {}), stop: async () => void (await set?.stop()) };
}
