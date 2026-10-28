import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { output } from "../core/output.ts";
import { gitMountArgs, guardGit } from "./git-guard.ts";
import type { RoleSkills } from "../core/skills.ts";
import { startServices } from "./services.ts";
import { startCredentialProxy, type CredentialProxy } from "./credential-proxy.ts";
import { effectiveEgress, pickProxyPort, startEgressProxy, type EgressProxy } from "./egress.ts";
import { CLAUDE_CREDENTIAL_VARS } from "../agents/claude.ts";
import { killGroup, teeStdout, type Sandbox } from "./exec.ts";
import baseDockerfile from "../../images/base/Dockerfile" with { type: "text" };

const BASE_IMAGE = "bunker-claude";

/** Builds the base image from the Dockerfile embedded in the bundle (it has no COPY, so stdin needs no context). */
export async function buildBaseImage(tag = BASE_IMAGE, dockerBin = "docker") {
  output.warn(`bunker: building ${tag}`);
  const proc = Bun.spawn([dockerBin, "build", "-q", "-t", tag, "-"], {
    stdin: new TextEncoder().encode(baseDockerfile),
    stdout: "ignore",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`docker build of ${tag} failed (exit ${code})`);
}

async function dockerBuild(bin: string, tag: string, context: string, dockerfile = join(context, "Dockerfile")) {
  output.warn(`bunker: building ${tag}`);
  const code = await Bun.spawn([bin, "build", "-q", "-t", tag, "-f", dockerfile, context], {
    stdio: ["ignore", "ignore", "inherit"],
  }).exited;
  if (code !== 0) throw new Error(`${bin} build of ${tag} failed (exit ${code})`);
}

/**
 * Picks the agent image: an explicit `image`, else the repo's .bunker/Dockerfile
 * (built FROM the base), else the base. The base is built on first use.
 */
async function resolveImage(bin: string, opts: DockerOptions, worktree: string, gitCommonDir: string): Promise<string> {
  if (opts.image) return opts.image;
  const base = opts.baseImage ?? BASE_IMAGE;
  if (base === BASE_IMAGE && (await $`${bin} image inspect ${base}`.quiet().nothrow()).exitCode !== 0) {
    await buildBaseImage(base, bin);
  }
  const repoDockerfile = join(worktree, ".bunker", "Dockerfile");
  if (!(await Bun.file(repoDockerfile).exists())) return base;
  // One tag per repo; docker's layer cache makes rebuilding on every run cheap.
  const repo = dirname(gitCommonDir);
  const slug = basename(repo).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const tag = `bunker-repo-${slug}-${Bun.hash(repo).toString(16).slice(0, 8)}`;
  await dockerBuild(bin, tag, dirname(repoDockerfile), repoDockerfile);
  return tag;
}

export interface DockerOptions {
  /** Use this image as-is, skipping the base and any .bunker/Dockerfile. */
  image?: string;
  /** Image a repo's .bunker/Dockerfile builds FROM. Defaults to bunker-claude (images/base). */
  baseImage?: string;
  /** Env var names passed through to the container. */
  env?: string[];
  /** Skill directories per role, mounted read-only into the container's ~/.claude/skills/<name>. */
  skills?: RoleSkills;
  /** Extra hosts (beyond DEFAULT_EGRESS) the agent may reach: the repo's `[sandbox] egress`. */
  egress?: string[];
  /** Container CLI to invoke. Defaults to the provider's own (`docker` / `podman`). */
  bin?: string;
  /** Resource limits per container; `pids` and `memory` (docker/podman syntax, e.g. 8g) default to DEFAULT_LIMITS. */
  limits?: { pids?: number; memory?: string };
}

export const DEFAULT_LIMITS = { pids: 4096, memory: "8g" };

/**
 * Runs the agent in a throwaway container. A worktree's .git is a file pointing at
 * <repo>/.git/worktrees/<id> by absolute path, so both the worktree and the repo's
 * .git are mounted at their host paths. Running as the host uid keeps every file
 * the agent writes (including git objects) owned by you, not root.
 */
export function docker(opts: DockerOptions = {}): Sandbox {
  const user = `${process.getuid?.()}:${process.getgid?.()}`;
  return containerSandbox(opts.bin ?? "docker", ["--user", user], opts);
}

/**
 * Same contract as docker(), for rootless podman. `--userns=keep-id` maps the host uid
 * into the container, so files the agent writes stay owned by you (podman's `--user`
 * alone would pick a uid inside the user namespace).
 */
export function podman(opts: DockerOptions = {}): Sandbox {
  return containerSandbox(opts.bin ?? "podman", ["--userns=keep-id"], opts);
}

/** Running containers (name -> bin) so an exiting CLI can stop them instead of orphaning the agent. */
export const liveContainers = new Map<string, string>();
/** Per-run service networks (name -> bin) so an exiting CLI can remove them: leaked ones exhaust docker's address pools. */
export const liveNetworks = new Map<string, string>();
let exitHooked = false;
/** Makes the process stop its live containers and remove its service networks on exit. */
export function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", stopLiveContainers);
}
export function stopLiveContainers() {
  const quiet = { stdio: ["ignore", "ignore", "ignore"] satisfies ["ignore", "ignore", "ignore"] };
  for (const [name, bin] of liveContainers) {
    Bun.spawnSync([bin, "kill", name], quiet);
    if (name.startsWith("bunker-svc-")) Bun.spawnSync([bin, "rm", "-f", name], quiet); // started without --rm
  }
  liveContainers.clear();
  for (const [network, bin] of liveNetworks) Bun.spawnSync([bin, "network", "rm", network], quiet);
  liveNetworks.clear();
}

/** The bridge non-isolated containers join. */
export const AGENT_NETWORK = "bunker-agent";

const agentNetworks = new Map<string, Promise<void>>();

/** Creates the agent bridge network if missing, once per process and runtime. Reusing one network avoids a veth add/remove per run. */
function ensureAgentNetwork(bin: string): Promise<void> {
  let p = agentNetworks.get(bin);
  if (!p) {
    p = (async () => {
      const quiet = { stdout: "ignore", stderr: "pipe" } as const;
      if ((await Bun.spawn([bin, "network", "inspect", AGENT_NETWORK], quiet).exited) === 0) return;
      const create = Bun.spawn([bin, "network", "create", AGENT_NETWORK], quiet);
      const [err, code] = await Promise.all([new Response(create.stderr).text(), create.exited]);
      // A parallel run may have created it between inspect and create.
      if (code !== 0 && (await Bun.spawn([bin, "network", "inspect", AGENT_NETWORK], quiet).exited) !== 0) {
        throw new Error(`could not create the ${AGENT_NETWORK} network: ${err.trim()}`);
      }
    })();
    p.catch(() => agentNetworks.delete(bin));
    agentNetworks.set(bin, p);
  }
  return p;
}

/** The agent network's gateway address, where the container reaches the host; undefined if the runtime doesn't say. */
async function agentGateway(bin: string): Promise<string | undefined> {
  const proc = Bun.spawn([bin, "network", "inspect", AGENT_NETWORK], { stdout: "pipe", stderr: "ignore" });
  const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  try {
    const net = (JSON.parse(text) as Record<string, unknown>[])[0] ?? {};
    const ipam = ((net.IPAM as { Config?: { Gateway?: string }[] } | undefined)?.Config ?? []).map((c) => c.Gateway);
    const subnets = (((net.subnets ?? net.Subnets) as { gateway?: string }[] | undefined) ?? []).map((c) => c.gateway);
    return [...ipam, ...subnets].find((g): g is string => !!g && !g.includes(":"));
  } catch {
    return undefined;
  }
}

const credentialProxies = new Map<string, Promise<CredentialProxy>>();

/** One proxy per process and runtime, listening on the agent network's gateway only. */
function credentialProxy(bin: string): Promise<CredentialProxy> {
  let p = credentialProxies.get(bin);
  if (!p) {
    p = (async () => {
      await ensureAgentNetwork(bin);
      const hostname = await agentGateway(bin);
      if (!hostname) throw new Error(`could not find the ${AGENT_NETWORK} gateway: the Claude credential proxy needs it`);
      const proxy = startCredentialProxy({
        port: await pickProxyPort(hostname),
        hostname,
        credentials: {
          ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } : {}),
          ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
        },
      });
      process.on("exit", () => proxy.stop());
      return proxy;
    })();
    p.catch(() => credentialProxies.delete(bin));
    credentialProxies.set(bin, p);
  }
  return p;
}

const egressProxies = new Map<string, Promise<{ proxy: EgressProxy; gateway: string }>>();

/** One egress proxy per runtime and allowlist, on the agent network's gateway. */
function egressProxy(bin: string, allow: string[]) {
  const key = `${bin}\0${[...allow].sort().join(",")}`;
  let p = egressProxies.get(key);
  if (!p) {
    p = (async () => {
      await ensureAgentNetwork(bin);
      const gateway = await agentGateway(bin);
      if (!gateway) throw new Error(`could not find the ${AGENT_NETWORK} gateway: the egress allowlist proxy needs it`);
      const proxy = startEgressProxy({ hostname: gateway, allow, port: await pickProxyPort(gateway) });
      process.on("exit", () => proxy.stop());
      return { proxy, gateway };
    })();
    p.catch(() => egressProxies.delete(key));
    egressProxies.set(key, p);
  }
  return p;
}

/** `-e` args that send the agent's HTTP(S) traffic through the allowlisting proxy; the gateway (credential proxy) stays direct. */
async function egressEnvArgs(bin: string, extra: string[] | undefined): Promise<string[]> {
  if (process.env.BUNKER_EGRESS_PROXY === "off") return []; // user-level escape hatch (a repo cannot set it)
  const { proxy, gateway } = await egressProxy(bin, effectiveEgress(extra));
  const url = `http://${gateway}:${proxy.port}`;
  const noProxy = `${gateway},localhost,127.0.0.1`;
  return ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].flatMap((k) => ["-e", `${k}=${url}`]).concat(["-e", `NO_PROXY=${noProxy}`, "-e", `no_proxy=${noProxy}`]);
}

/** `-e` args for the agent: Claude credentials become placeholders and ANTHROPIC_BASE_URL the proxy; other names pass by name. */
async function agentEnvArgs(bin: string, names: string[]): Promise<string[]> {
  const isCred = (n: string) => (CLAUDE_CREDENTIAL_VARS as readonly string[]).includes(n);
  const held = names.filter((n) => isCred(n) && process.env[n]);
  const args = names.filter((n) => !isCred(n)).flatMap((n) => ["-e", n]); // name only: value comes from our env, never argv
  if (!held.length) return args;
  const proxy = await credentialProxy(bin);
  for (const n of held) args.push("-e", `${n}=${proxy.placeholders[n as keyof typeof proxy.placeholders]}`);
  args.push("-e", `ANTHROPIC_BASE_URL=${proxy.url}`);
  return args;
}

export function containerSandbox(bin: string, userArgs: string[], opts: DockerOptions): Sandbox {
  const env = opts.env ?? ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  // runAll() calls exec once per task at the same time; share one image build per repo.
  const images = new Map<string, Promise<string>>();
  // The container is throwaway; its claude session files live in a host dir mounted over ~/.claude/projects.
  let store: string | undefined;
  return {
    startServices: (services) => startServices(bin, services),
    get projectsDir() {
      if (!store) {
        store = mkdtempSync(join(tmpdir(), "bunker-claude-projects-"));
        const dir = store;
        process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
      }
      return store;
    },
    exec(cmd, ctx) {
      // Arrow function: `this.projectsDir` below still means this sandbox.
      return guardGit(ctx.worktree, ctx.gitCommonDir, async () => {
      const { worktree, gitCommonDir, prefix, onLine, limits, isolate, network, stdin, role } = ctx;
      const [entrypoint, ...args] = cmd;
      if (!entrypoint) throw new Error("empty agent command");
      if (!images.has(gitCommonDir)) images.set(gitCommonDir, resolveImage(bin, opts, worktree, gitCommonDir));
      const image = await images.get(gitCommonDir)!;
      // ~/.gitconfig isn't in the container, so carry the commit identity over.
      const name = (await $`git -C ${worktree} config user.name`.nothrow().text()).trim();
      const email = (await $`git -C ${worktree} config user.email`.nothrow().text()).trim();
      const identity = Object.entries({
        GIT_AUTHOR_NAME: name,
        GIT_COMMITTER_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_EMAIL: email,
      }).flatMap(([k, v]) => (v ? ["-e", `${k}=${v}`] : []));
      if (!network && !isolate) await ensureAgentNetwork(bin);
      const agentEnv = isolate ? [] : await agentEnvArgs(bin, env);
      // Only the plain agent network has a way out; services networks are internal and verify has none.
      const egressEnv = !network && !isolate ? await egressEnvArgs(bin, opts.egress) : [];
      const cname = `bunker-${crypto.randomUUID().slice(0, 12)}`;
      const argv = [
        bin, "run", "--rm", ...(stdin === undefined ? [] : ["-i"]), "--name", cname,
        ...userArgs,
        // Locked at creation: no capabilities, no privilege gain via setuid binaries, bounded processes and memory.
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", String(opts.limits?.pids ?? DEFAULT_LIMITS.pids), "--memory", opts.limits?.memory ?? DEFAULT_LIMITS.memory,
        "-e", "HOME=/tmp",
        // Marks the container so a bunker CLI run from inside it refuses to start (it would drive the live queue with our token).
        "-e", "BUNKER_IN_SANDBOX=1",
        // Verify runs code the agent wrote: no network to send anything out, and no credentials to send.
        // Non-isolated runs join one long-lived bridge network (not the default bridge, which creates and removes a veth per run and makes Chrome fail with ERR_NETWORK_CHANGED).
        // Not the host network: the container has its own loopback, so the host's 127.0.0.1 services are out of reach.
        // With services the command joins their internal network (no route out) instead.
        ...(network ? ["--network", network, ...agentEnv] : isolate ? ["--network", "none"] : ["--network", AGENT_NETWORK, ...agentEnv, ...egressEnv]),
        ...identity,
        "-v", `${this.projectsDir}:/tmp/.claude/projects`,
        ...(role ? opts.skills?.[role] ?? [] : []).flatMap((k) => ["-v", `${k.path}:/tmp/.claude/skills/${k.name}:ro`]),
        ...gitMountArgs(worktree, gitCommonDir),
        "-w", worktree,
        "--entrypoint", entrypoint,
        image,
        ...args,
      ];
      const proc = Bun.spawn(argv, { env: process.env, stdio: [stdin === undefined ? "ignore" : new Blob([stdin]), "pipe", "inherit"], detached: true });
      // Killing the CLI client would leave the container running; stop the container itself too.
      const kill = () => {
        Bun.spawn([bin, "kill", cname], { stdio: ["ignore", "ignore", "ignore"] });
        killGroup(proc);
      };
      hookExit();
      liveContainers.set(cname, bin);
      return teeStdout(proc, prefix, onLine, limits, kill).finally(() => liveContainers.delete(cname));
      });
    },
  };
}
