import { hookExit, liveContainers, liveNetworks } from "./container.ts";

/** A throwaway service (e.g. Postgres) started next to verify, reachable from it by the name it is declared under. */
export interface ServiceConfig {
  image: string;
  env?: Record<string, string>;
  /** Shell command run inside the service container; verify starts once it exits 0. Without one, verify starts right away. */
  healthcheck?: string;
}

export type Services = Record<string, ServiceConfig>;

/** Services that are up: verify joins `network`, which has no way out and holds nothing but these. */
export interface ServiceSet {
  network: string;
  /** Removes the containers and the network. Safe to call twice. */
  stop(): Promise<void>;
}

export interface ServiceTiming {
  /** Gives up on a healthcheck after this long. Defaults to 60 s. */
  healthTimeoutMs?: number;
  /** Time between healthcheck runs. Defaults to 1 s. */
  healthIntervalMs?: number;
}

export class ServiceError extends Error {}

async function run(bin: string, args: string[], env?: Record<string, string | undefined>): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([bin, ...args], { ...(env ? { env: env as Record<string, string> } : {}), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.exitCode ?? 1, text: (out + err).trim() };
}

/**
 * Starts `services` on a fresh internal network (no route out) named for this run alone, so parallel runs never share
 * state; each service is reachable by its declared name. Everything is removed again by `stop()`, also when a service
 * fails to start or to become healthy (then this throws a ServiceError after cleaning up).
 */
export async function startServices(bin: string, services: Services, timing: ServiceTiming = {}): Promise<ServiceSet> {
  const id = crypto.randomUUID().slice(0, 12);
  const network = `bunker-net-${id}`;
  const started: string[] = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const name of started) {
      await run(bin, ["rm", "-f", name]);
      liveContainers.delete(name);
    }
    if (liveNetworks.delete(network)) await run(bin, ["network", "rm", network]);
  };
  const net = await run(bin, ["network", "create", "--internal", network]);
  if (net.code !== 0) throw new ServiceError(`could not create the service network: ${net.text}`);
  liveNetworks.set(network, bin);
  hookExit();
  try {
    for (const [name, svc] of Object.entries(services)) {
      const cname = `bunker-svc-${id}-${name}`;
      const env = Object.entries(svc.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      started.push(cname);
      liveContainers.set(cname, bin);
      const r = await run(bin, ["run", "-d", "--name", cname, "--network", network, "--network-alias", name, ...env, svc.image]);
      if (r.code !== 0) throw new ServiceError(`service ${name} (${svc.image}) did not start: ${r.text}`);
    }
    const timeout = timing.healthTimeoutMs ?? 60_000;
    for (const [name, svc] of Object.entries(services)) {
      if (!svc.healthcheck) continue;
      const cname = `bunker-svc-${id}-${name}`;
      const deadline = Date.now() + timeout;
      for (;;) {
        if ((await run(bin, ["exec", cname, "sh", "-c", svc.healthcheck])).code === 0) break;
        if (Date.now() >= deadline) throw new ServiceError(`service ${name} was not healthy after ${Math.round(timeout / 1000)}s (healthcheck: ${svc.healthcheck})`);
        await Bun.sleep(timing.healthIntervalMs ?? 1000);
      }
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { network, stop };
}

/** Pulls each image (as `bunker doctor` and `bunker init` check); the names of those that can't be pulled. */
export async function unpullable(bin: string, services: Services, env?: Record<string, string | undefined>): Promise<{ name: string; image: string; error: string }[]> {
  const out: { name: string; image: string; error: string }[] = [];
  for (const [name, svc] of Object.entries(services)) {
    const have = await run(bin, ["image", "inspect", svc.image], env);
    if (have.code === 0) continue;
    const pulled = await run(bin, ["pull", "-q", svc.image], env);
    if (pulled.code !== 0) out.push({ name, image: svc.image, error: pulled.text.split("\n").pop() ?? "" });
  }
  return out;
}
