import { $ } from "bun";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Turns a prompt into the command line that runs the agent. */
export interface Agent {
  command(prompt: string): string[];
}

/** Where the agent's command runs. Gets the worktree and the repo's shared .git dir. */
export interface Sandbox {
  exec(cmd: string[], ctx: { worktree: string; gitCommonDir: string }): Promise<number>;
}

export interface Commit {
  sha: string;
  subject: string;
}

export interface RunOptions {
  prompt: string;
  agent: Agent;
  sandbox: Sandbox;
  /** Repo to branch from and merge back into. Defaults to process.cwd(). */
  cwd?: string;
}

export interface RunResult {
  branch: string;
  commits: Commit[];
}

const COMMIT_INSTRUCTION =
  "\n\nWhen you are done, commit your changes with git. Uncommitted work is discarded.";

export function claudeCode(opts: { model?: string } = {}): Agent {
  return {
    command: (prompt) => [
      "claude",
      "-p",
      prompt + COMMIT_INSTRUCTION,
      "--dangerously-skip-permissions",
      ...(opts.model ? ["--model", opts.model] : []),
    ],
  };
}

/** Runs the agent straight on the host, in the worktree. No isolation. */
export function noSandbox(): Sandbox {
  return {
    exec: (cmd, { worktree }) =>
      Bun.spawn(cmd, { cwd: worktree, stdio: ["ignore", "inherit", "inherit"] }).exited,
  };
}

const BASE_IMAGE = "bunker-claude";
const BASE_CONTEXT = join(import.meta.dir, "..", "images", "base");

async function dockerBuild(tag: string, context: string, dockerfile = join(context, "Dockerfile")) {
  console.error(`bunker: building ${tag}`);
  const code = await Bun.spawn(["docker", "build", "-q", "-t", tag, "-f", dockerfile, context], {
    stdio: ["ignore", "ignore", "inherit"],
  }).exited;
  if (code !== 0) throw new Error(`docker build of ${tag} failed (exit ${code})`);
}

/**
 * Picks the agent image: an explicit `image`, else the repo's .bunker/Dockerfile
 * (built FROM the base), else the base. The base is built on first use.
 */
async function resolveImage(opts: DockerOptions, worktree: string, gitCommonDir: string): Promise<string> {
  if (opts.image) return opts.image;
  const base = opts.baseImage ?? BASE_IMAGE;
  if (base === BASE_IMAGE && (await $`docker image inspect ${base}`.quiet().nothrow()).exitCode !== 0) {
    await dockerBuild(base, BASE_CONTEXT);
  }
  const repoDockerfile = join(worktree, ".bunker", "Dockerfile");
  if (!(await Bun.file(repoDockerfile).exists())) return base;
  // One tag per repo; docker's layer cache makes rebuilding on every run cheap.
  const repo = dirname(gitCommonDir);
  const slug = basename(repo).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const tag = `bunker-repo-${slug}-${Bun.hash(repo).toString(16).slice(0, 8)}`;
  await dockerBuild(tag, dirname(repoDockerfile), repoDockerfile);
  return tag;
}

export interface DockerOptions {
  /** Use this image as-is, skipping the base and any .bunker/Dockerfile. */
  image?: string;
  /** Image a repo's .bunker/Dockerfile builds FROM. Defaults to bunker-claude (images/base). */
  baseImage?: string;
  /** Env var names passed through to the container. */
  env?: string[];
}

/**
 * Runs the agent in a throwaway container. A worktree's .git is a file pointing at
 * <repo>/.git/worktrees/<id> by absolute path, so both the worktree and the repo's
 * .git are mounted at their host paths. Running as the host uid keeps every file
 * the agent writes (including git objects) owned by you, not root.
 */
export function docker(opts: DockerOptions = {}): Sandbox {
  const env = opts.env ?? ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  return {
    async exec(cmd, { worktree, gitCommonDir }) {
      const [entrypoint, ...args] = cmd;
      if (!entrypoint) throw new Error("empty agent command");
      const image = await resolveImage(opts, worktree, gitCommonDir);
      // ~/.gitconfig isn't in the container, so carry the commit identity over.
      const name = (await $`git -C ${worktree} config user.name`.nothrow().text()).trim();
      const email = (await $`git -C ${worktree} config user.email`.nothrow().text()).trim();
      const identity = Object.entries({
        GIT_AUTHOR_NAME: name,
        GIT_COMMITTER_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_EMAIL: email,
      }).flatMap(([k, v]) => (v ? ["-e", `${k}=${v}`] : []));
      const docker = [
        "docker", "run", "--rm",
        "--user", `${process.getuid?.()}:${process.getgid?.()}`,
        "-e", "HOME=/tmp",
        ...env.flatMap((name) => ["-e", name]), // name only: value comes from our env, never argv
        ...identity,
        "-v", `${worktree}:${worktree}`,
        "-v", `${gitCommonDir}:${gitCommonDir}`,
        "-w", worktree,
        "--entrypoint", entrypoint,
        image,
        ...args,
      ];
      return Bun.spawn(docker, { stdio: ["ignore", "inherit", "inherit"] }).exited;
    },
  };
}

async function commitsBetween(cwd: string, base: string, branch: string): Promise<Commit[]> {
  const out = await $`git -C ${cwd} log --reverse --format=%H%x09%s ${base}..${branch}`.text();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\t");
      return { sha, subject };
    });
}

/**
 * Branch → sandbox → collect → merge. On agent failure the worktree is removed
 * but the branch is kept so you can inspect what it got done.
 */
export async function run({ prompt, agent, sandbox, cwd = process.cwd() }: RunOptions): Promise<RunResult> {
  const id = crypto.randomUUID().slice(0, 8);
  const branch = `bunker/${id}`;
  const worktree = join(tmpdir(), `bunker-${id}`);
  const base = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim();
  const gitCommonDir = (await $`git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`.text()).trim();

  await $`git -C ${cwd} worktree add -q -b ${branch} ${worktree} ${base}`;
  let commits: Commit[];
  try {
    const code = await sandbox.exec(agent.command(prompt), { worktree, gitCommonDir });
    if (code !== 0) throw new Error(`agent exited with ${code}; work kept on ${branch}`);
    commits = await commitsBetween(cwd, base, branch);
  } finally {
    await $`git -C ${cwd} worktree remove --force ${worktree}`.quiet();
  }

  if (commits.length > 0) {
    const merge = await $`git -C ${cwd} merge -q --no-edit ${branch}`.nothrow().quiet();
    if (merge.exitCode !== 0) {
      await $`git -C ${cwd} merge --abort`.nothrow().quiet();
      throw new Error(`merge of ${branch} failed; branch kept:\n${merge.stderr}`);
    }
  }
  await $`git -C ${cwd} branch -q -D ${branch}`;
  return { branch, commits };
}
