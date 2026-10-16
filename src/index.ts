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
      // Explicit env: Bun.spawn otherwise passes the startup environment, dropping
      // anything set at runtime (e.g. the token loaded from .bunker/.env).
      Bun.spawn(cmd, { cwd: worktree, env: process.env, stdio: ["ignore", "inherit", "inherit"] }).exited,
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
  // runAll() calls exec once per task at the same time; share one image build per repo.
  const images = new Map<string, Promise<string>>();
  return {
    async exec(cmd, { worktree, gitCommonDir }) {
      const [entrypoint, ...args] = cmd;
      if (!entrypoint) throw new Error("empty agent command");
      if (!images.has(gitCommonDir)) images.set(gitCommonDir, resolveImage(opts, worktree, gitCommonDir));
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
      return Bun.spawn(docker, { env: process.env, stdio: ["ignore", "inherit", "inherit"] }).exited;
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

interface Worktree {
  branch: string;
  path: string;
}

async function repoInfo(cwd: string) {
  const base = (await $`git -C ${cwd} rev-parse HEAD`.text()).trim();
  const gitCommonDir = (await $`git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
  return { base, gitCommonDir };
}

async function addWorktree(cwd: string, base: string): Promise<Worktree> {
  const id = crypto.randomUUID().slice(0, 8);
  const wt = { branch: `bunker/${id}`, path: join(tmpdir(), `bunker-${id}`) };
  await $`git -C ${cwd} worktree add -q -b ${wt.branch} ${wt.path} ${base}`;
  return wt;
}

/** Runs the agent in the worktree and returns its commits. The worktree is always removed; the branch never is. */
async function runAgent(
  cwd: string,
  base: string,
  gitCommonDir: string,
  wt: Worktree,
  prompt: string,
  agent: Agent,
  sandbox: Sandbox,
): Promise<Commit[]> {
  try {
    const code = await sandbox.exec(agent.command(prompt), { worktree: wt.path, gitCommonDir });
    if (code !== 0) throw new Error(`agent exited with ${code}; work kept on ${wt.branch}`);
    return await commitsBetween(cwd, base, wt.branch);
  } finally {
    await $`git -C ${cwd} worktree remove --force ${wt.path}`.quiet();
  }
}

/** Merges the branch into the caller's checkout and deletes it. On conflict: aborts, keeps the branch, returns the error. */
async function mergeBack(cwd: string, branch: string, commits: Commit[]): Promise<string | undefined> {
  if (commits.length > 0) {
    const merge = await $`git -C ${cwd} merge -q --no-edit ${branch}`.nothrow().quiet();
    if (merge.exitCode !== 0) {
      await $`git -C ${cwd} merge --abort`.nothrow().quiet();
      return `merge conflict on ${branch}; branch kept:\n${merge.stdout}${merge.stderr}`;
    }
  }
  await $`git -C ${cwd} branch -q -D ${branch}`;
}

/**
 * Branch → sandbox → collect → merge. On agent failure or merge conflict it throws,
 * keeping the branch so you can inspect what it got done.
 */
export async function run({ prompt, agent, sandbox, cwd = process.cwd() }: RunOptions): Promise<RunResult> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const wt = await addWorktree(cwd, base);
  const commits = await runAgent(cwd, base, gitCommonDir, wt, prompt, agent, sandbox);
  const conflict = await mergeBack(cwd, wt.branch, commits);
  if (conflict) throw new Error(conflict);
  return { branch: wt.branch, commits };
}

export interface RunAllOptions {
  tasks: { prompt: string }[];
  agent: Agent;
  sandbox: Sandbox;
  cwd?: string;
}

export interface TaskResult {
  prompt: string;
  status: "merged" | "conflict" | "failed";
  branch: string;
  commits: Commit[];
  error?: string;
}

/**
 * One worktree per task, all from the same base. Worktrees are created one at a
 * time (git takes locks on the shared .git), agents run concurrently, and merges
 * land one at a time in task order. A task's failure or conflict is reported in
 * its result, never thrown, and its branch is kept.
 */
export async function runAll({ tasks, agent, sandbox, cwd = process.cwd() }: RunAllOptions): Promise<TaskResult[]> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const worktrees: Worktree[] = [];
  for (const _ of tasks) worktrees.push(await addWorktree(cwd, base));

  const outcomes = await Promise.allSettled(
    tasks.map((task, i) => runAgent(cwd, base, gitCommonDir, worktrees[i]!, task.prompt, agent, sandbox)),
  );

  const results: TaskResult[] = [];
  for (const [i, outcome] of outcomes.entries()) {
    const { prompt } = tasks[i]!;
    const { branch } = worktrees[i]!;
    if (outcome.status === "rejected") {
      const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      results.push({ prompt, status: "failed", branch, commits: [], error });
      continue;
    }
    const commits = outcome.value;
    const conflict = await mergeBack(cwd, branch, commits);
    results.push(
      conflict ? { prompt, status: "conflict", branch, commits, error: conflict } : { prompt, status: "merged", branch, commits },
    );
  }
  return results;
}
