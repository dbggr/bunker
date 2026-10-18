import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { output } from "../core/output.ts";
import { gitMountArgs, guardGit } from "./git-guard.ts";
import type { RoleSkills } from "../core/skills.ts";
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
  /** Container CLI to invoke. Defaults to the provider's own (`docker` / `podman`). */
  bin?: string;
}

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

export function containerSandbox(bin: string, userArgs: string[], opts: DockerOptions): Sandbox {
  const env = opts.env ?? ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  // runAll() calls exec once per task at the same time; share one image build per repo.
  const images = new Map<string, Promise<string>>();
  // The container is throwaway; its claude session files live in a host dir mounted over ~/.claude/projects.
  let store: string | undefined;
  return {
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
      const { worktree, gitCommonDir, prefix, onLine, limits, isolate, stdin, role } = ctx;
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
      const cname = `bunker-${crypto.randomUUID().slice(0, 12)}`;
      const argv = [
        bin, "run", "--rm", ...(stdin === undefined ? [] : ["-i"]), "--name", cname,
        ...userArgs,
        "-e", "HOME=/tmp",
        // Verify runs code the agent wrote: no network to send anything out, and no credentials to send.
        // Non-isolated runs use the host network: the default bridge creates and removes a veth per run, and each link event makes Chrome fail in-flight requests (ERR_NETWORK_CHANGED).
        // Tradeoff: the container can reach the host's localhost services; it already runs the agent with credentials and full outbound network.
        ...(isolate ? ["--network", "none"] : ["--network", "host", ...env.flatMap((name) => ["-e", name])]), // name only: value comes from our env, never argv
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
      return teeStdout(proc, prefix, onLine, limits, kill);
      });
    },
  };
}
