import { $ } from "bun";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redact } from "./redact.ts";
import { output, tailLines } from "./output.ts";
import { emit, findStreamResult, parseClaudeStreamLine, type OnEvent, type Stage, type StreamEvent } from "./events.ts";
export type { BunkerEvent, OnEvent } from "./events.ts";
import baseDockerfile from "../images/base/Dockerfile" with { type: "text" };

export type AgentMode = "write" | "review";

/** Turns a prompt into the command line that runs the agent. */
export interface Agent {
  /** "review" is a read-only pass over someone else's work; "write" (default) is expected to commit. */
  command(prompt: string, mode?: AgentMode): string[];
  /** Turns the command's raw stdout into the agent's text plus what the run cost. Omit if stdout is already the text. */
  parse?(stdout: string): { text: string; usage?: Usage };
  /** Turns one line of the command's stdout into progress events. Omit if stdout isn't a stream. */
  parseLine?(line: string): StreamEvent[];
}

/** What a run cost. */
export interface Usage {
  costUsd: number;
  durationMs: number;
}

/** The agent's text (for signals and feedback) and usage from raw stdout. */
function interpret(agent: Agent, stdout: string): { text: string; usage?: Usage } {
  return agent.parse ? agent.parse(stdout) : { text: stdout };
}

/** Sums usages; undefined if none was reported. */
export function sumUsage(items: (Usage | undefined)[]): Usage | undefined {
  const known = items.filter((u): u is Usage => !!u);
  if (!known.length) return undefined;
  return {
    costUsd: known.reduce((a, u) => a + u.costUsd, 0),
    durationMs: known.reduce((a, u) => a + u.durationMs, 0),
  };
}

/** "1m 5s" */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** "$0.42, 1m 5s agent time". The time is what the agent reported, not wall-clock. */
export function formatUsage(u: Usage): string {
  return `$${u.costUsd.toFixed(2)}, ${formatDuration(u.durationMs)} agent time`;
}

/** Where the agent's command runs. Gets the worktree and the repo's shared .git dir. */
export interface Sandbox {
  exec(cmd: string[], ctx: { worktree: string; gitCommonDir: string; prefix?: string; onLine?: (line: string) => void }): Promise<{ code: number; stdout: string }>;
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
  /** Max times to run the agent, in the same worktree. Defaults to 1. */
  maxIterations?: number;
  /** Stop after an iteration whose stdout contains any of these. Defaults to "<promise>COMPLETE</promise>". */
  completionSignal?: string | string[];
  /** Progress events: stages, agent text and tool calls, results. */
  onEvent?: OnEvent;
}

export interface Iteration {
  exitCode: number;
  /** Commits this iteration added. */
  commits: Commit[];
  usage?: Usage;
}

export interface RunResult {
  branch: string;
  /** Total across all iterations. */
  commits: Commit[];
  iterations: Iteration[];
  /** The signal that ended the loop early, if one did. */
  completionSignal?: string;
  /** Total across all iterations, if the agent reports it. */
  usage?: Usage;
}

const DEFAULT_SIGNAL = "<promise>COMPLETE</promise>";

const COMMIT_INSTRUCTION =
  "\n\nWhen you are done, commit your changes with git. Uncommitted work is discarded.";

// The container has no ~/.claude/settings.json, so claude would add its
// Co-Authored-By / "Generated with" lines. Pass the setting on every run so it
// holds in any image, not just the base.
const NO_ATTRIBUTION = JSON.stringify({ attribution: { commit: "", pr: "" } });

/** Reads `claude -p --output-format stream-json` output (its final `result` event); anything else is passed through as plain text. */
function parseClaudeJson(stdout: string): { text: string; usage?: Usage } {
  const final = findStreamResult(stdout);
  if (final) return { text: final.text, ...(final.usage ? { usage: final.usage } : {}) };
  try {
    const j = JSON.parse(stdout);
    if (typeof j?.result !== "string") return { text: stdout };
    const cost = j.total_cost_usd;
    const ms = j.duration_ms;
    return {
      text: j.result,
      ...(typeof cost === "number" ? { usage: { costUsd: cost, durationMs: typeof ms === "number" ? ms : 0 } } : {}),
    };
  } catch {
    return { text: stdout };
  }
}

export function claudeCode(opts: { model?: string; attribution?: boolean; json?: boolean } = {}): Agent {
  return {
    ...(opts.json ? { parse: parseClaudeJson, parseLine: parseClaudeStreamLine } : {}),
    command: (prompt, mode = "write") => [
      "claude",
      "-p",
      mode === "write" ? prompt + COMMIT_INSTRUCTION : prompt,
      "--dangerously-skip-permissions",
      ...(opts.json ? ["--output-format", "stream-json", "--verbose"] : []),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.attribution ? [] : ["--settings", NO_ATTRIBUTION]),
    ],
  };
}

function prefixLines(text: string, prefix: string): string {
  return prefix ? text.replace(/^(?=.)/gm, prefix) : text;
}

/** Waits for the process, echoing its (redacted) stdout live (verbose only), each line led by `prefix`, while capturing it unprefixed. */
async function teeStdout(proc: Bun.Subprocess<"ignore", "pipe", "inherit">, prefix = "", onLine?: (line: string) => void): Promise<{ code: number; stdout: string }> {
  // With onLine, lines are handed over (redacted) instead of echoed.
  const out = (text: string) => {
    if (!onLine) {
      if (output.verbose) output.write(prefixLines(redact(text), prefix));
    }
    else for (const line of text.split("\n")) if (line) onLine(redact(line));
  };
  const decoder = new TextDecoder();
  let stdout = "";
  // Echo whole lines only, so a secret split across chunks is still caught.
  let pending = "";
  for await (const chunk of proc.stdout) {
    const text = decoder.decode(chunk, { stream: true });
    stdout += text;
    pending += text;
    const nl = pending.lastIndexOf("\n");
    if (nl >= 0) {
      out(pending.slice(0, nl + 1));
      pending = pending.slice(nl + 1);
    }
  }
  const tail = decoder.decode();
  stdout += tail;
  pending += tail;
  if (pending) out(pending);
  return { code: await proc.exited, stdout: redact(stdout) };
}

/** GitHub credentials bunker itself uses; an agent must never see them. */
export const GH_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "BUNKER_GH_TOKEN"] as const;

/** Runs the agent straight on the host, in the worktree. No isolation (GitHub tokens are stripped from its env). */
export function noSandbox(): Sandbox {
  return {
    exec: (cmd, { worktree, prefix, onLine }) =>
      // detached: own process group, so a terminal Ctrl-C reaches only bunker, which lets the step finish.
      // Explicit env: Bun.spawn otherwise passes the startup environment, dropping
      // anything set at runtime (e.g. the token loaded from .bunker/.env).
      teeStdout(Bun.spawn(cmd, { cwd: worktree, env: agentEnv(), stdio: ["ignore", "pipe", "inherit"], detached: true }), prefix, onLine),
  };
}

function agentEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const name of GH_TOKEN_VARS) delete env[name];
  return env;
}

const BASE_IMAGE = "bunker-claude";

/** Builds the base image from the Dockerfile embedded in the bundle (it has no COPY, so stdin needs no context). */
export async function buildBaseImage(tag = BASE_IMAGE, dockerBin = "docker") {
  console.error(`bunker: building ${tag}`);
  const proc = Bun.spawn([dockerBin, "build", "-q", "-t", tag, "-"], {
    stdin: new TextEncoder().encode(baseDockerfile),
    stdout: "ignore",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`docker build of ${tag} failed (exit ${code})`);
}

async function dockerBuild(bin: string, tag: string, context: string, dockerfile = join(context, "Dockerfile")) {
  console.error(`bunker: building ${tag}`);
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

function containerSandbox(bin: string, userArgs: string[], opts: DockerOptions): Sandbox {
  const env = opts.env ?? ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  // runAll() calls exec once per task at the same time; share one image build per repo.
  const images = new Map<string, Promise<string>>();
  return {
    async exec(cmd, { worktree, gitCommonDir, prefix, onLine }) {
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
      const argv = [
        bin, "run", "--rm",
        ...userArgs,
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
      return teeStdout(Bun.spawn(argv, { env: process.env, stdio: ["ignore", "pipe", "inherit"], detached: true }), prefix, onLine);
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

/**
 * Runs the setup step in `worktree`, inside `sandbox`: `setup` if given, else the repo's
 * `.bunker/setup` script if present. Returns undefined on success (or no setup), else the failure text.
 */
export async function runSetup(
  sandbox: Sandbox,
  ctx: { worktree: string; gitCommonDir: string },
  setup?: string,
): Promise<{ cmd: string; code: number; stdout: string } | undefined> {
  const cmd = setup ?? ((await Bun.file(join(ctx.worktree, ".bunker", "setup")).exists()) ? "sh .bunker/setup" : undefined);
  if (!cmd) return undefined;
  const out = await sandbox.exec(["sh", "-c", `(${cmd}) 2>&1`], ctx);
  return { cmd, ...out };
}

async function addWorktree(cwd: string, base: string): Promise<Worktree> {
  const id = crypto.randomUUID().slice(0, 8);
  const wt = { branch: `bunker/${id}`, path: join(tmpdir(), `bunker-${id}`) };
  await $`git -C ${cwd} worktree add -q -b ${wt.branch} ${wt.path} ${base}`;
  return wt;
}

/** Where an agent run's events are labelled from, and where raw stdout lines go. */
export interface EventTarget {
  onEvent?: OnEvent | undefined;
  /** Every raw stdout line of a streaming agent (already redacted). */
  onRaw?: ((line: string) => void) | undefined;
  task?: number;
  round?: number;
  role?: "implementer" | "reviewer";
}

/** The exec `onLine` hook for `agent`: parsed events to onEvent, raw lines to onRaw. Undefined if nobody listens or the agent doesn't stream. */
function lineHook(agent: Agent, t: EventTarget): ((line: string) => void) | undefined {
  if (!agent.parseLine || (!t.onEvent && !t.onRaw)) return undefined;
  const label = { ...(t.task !== undefined ? { task: t.task } : {}), ...(t.round !== undefined ? { round: t.round } : {}), ...(t.role ? { role: t.role } : {}) };
  return (line) => {
    t.onRaw?.(line);
    for (const e of agent.parseLine!(line)) {
      if (e.type === "text") emit(t.onEvent, { type: "text", ...label, text: e.text });
      else if (e.type === "toolCall") emit(t.onEvent, { type: "toolCall", ...label, name: e.summary });
      else emit(t.onEvent, { type: "result", ...label, ...(e.usage ? { costUsd: e.usage.costUsd } : {}) });
    }
  };
}

export function emitStage(t: Pick<EventTarget, "onEvent" | "task" | "round" | "role">, name: Stage, text?: string) {
  emit(t.onEvent, { type: "stage", name, ...(t.task !== undefined ? { task: t.task } : {}), ...(t.round !== undefined ? { round: t.round } : {}), ...(t.role ? { role: t.role } : {}), ...(text ? { text } : {}) });
}

/** A failed agent run; carries the usage already spent. */
export class AgentFailure extends Error {
  constructor(message: string, readonly usage?: Usage) {
    super(message);
  }
}

interface AgentOutcome {
  commits: Commit[];
  iterations: Iteration[];
  completionSignal?: string;
  usage?: Usage;
}

/**
 * Runs the agent in the worktree, again and again with the same prompt until an
 * iteration's stdout has a completion signal or maxIterations is reached.
 * The worktree is always removed; the branch never is.
 */
async function runAgent(
  cwd: string,
  base: string,
  gitCommonDir: string,
  wt: Worktree,
  { prompt, agent, sandbox, maxIterations = 1, completionSignal = DEFAULT_SIGNAL, onEvent }: Omit<RunOptions, "cwd">,
  prefix?: string,
  task?: number,
): Promise<AgentOutcome> {
  const signals = [completionSignal].flat();
  const iterations: Iteration[] = [];
  let commits: Commit[] = [];
  try {
    for (let i = 0; i < maxIterations; i++) {
      const target = { onEvent, task, round: i + 1, role: "implementer" as const };
      emitStage(target, "implement");
      const onLine = lineHook(agent, target);
      const { code, stdout } = await sandbox.exec(agent.command(prompt), { worktree: wt.path, gitCommonDir, ...(prefix ? { prefix } : {}), ...(onLine ? { onLine } : {}) });
      const { text, usage } = interpret(agent, stdout);
      if (code !== 0) {
        throw new AgentFailure(`agent exited with ${code}; work kept on ${wt.branch}`, sumUsage([...iterations.map((i) => i.usage), usage]));
      }
      const total = await commitsBetween(cwd, base, wt.branch);
      iterations.push({ exitCode: code, commits: total.slice(commits.length), ...(usage ? { usage } : {}) });
      commits = total;
      const matched = signals.find((s) => text.includes(s));
      if (matched) return { commits, iterations, completionSignal: matched, ...totalUsage(iterations) };
    }
    return { commits, iterations, ...totalUsage(iterations) };
  } finally {
    await $`git -C ${cwd} worktree remove --force ${wt.path}`.quiet();
  }
}

function totalUsage(iterations: Iteration[]): { usage?: Usage } {
  const usage = sumUsage(iterations.map((i) => i.usage));
  return usage ? { usage } : {};
}

/** Merges the branch into the caller's checkout and deletes it. On conflict: aborts, keeps the branch, returns the error. */
async function mergeBack(cwd: string, branch: string, commits: Commit[]): Promise<string | undefined> {
  if (commits.length > 0) {
    const merge = await $`git -C ${cwd} merge -q --no-edit ${branch}`.nothrow().quiet();
    if (merge.exitCode !== 0) {
      await $`git -C ${cwd} merge --abort`.nothrow().quiet();
      return redact(`merge conflict on ${branch}; branch kept:\n${merge.stdout}${merge.stderr}`);
    }
  }
  await $`git -C ${cwd} branch -q -D ${branch}`;
}

/**
 * Branch → sandbox → collect → merge. On agent failure or merge conflict it throws,
 * keeping the branch so you can inspect what it got done.
 */
export async function run({ cwd = process.cwd(), ...opts }: RunOptions): Promise<RunResult> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const wt = await addWorktree(cwd, base);
  const outcome = await runAgent(cwd, base, gitCommonDir, wt, opts);
  const conflict = await mergeBack(cwd, wt.branch, outcome.commits);
  if (conflict) throw new Error(conflict);
  return { branch: wt.branch, ...outcome };
}

export interface RunAllOptions {
  tasks: { prompt: string }[];
  agent: Agent;
  sandbox: Sandbox;
  cwd?: string;
  /** Per task, as in run(). */
  maxIterations?: number;
  completionSignal?: string | string[];
  onEvent?: OnEvent;
}

export interface TaskResult {
  prompt: string;
  status: "merged" | "conflict" | "failed";
  branch: string;
  commits: Commit[];
  iterations: Iteration[];
  completionSignal?: string;
  usage?: Usage;
  error?: string;
}

/**
 * One worktree per task, all from the same base. Worktrees are created one at a
 * time (git takes locks on the shared .git), agents run concurrently, and merges
 * land one at a time in task order. A task's failure or conflict is reported in
 * its result, never thrown, and its branch is kept. Live output lines are
 * prefixed with the task index (`[2] `); captured stdout is not.
 */
export async function runAll({ tasks, cwd = process.cwd(), ...opts }: RunAllOptions): Promise<TaskResult[]> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const worktrees: Worktree[] = [];
  for (const _ of tasks) worktrees.push(await addWorktree(cwd, base));

  const outcomes = await Promise.allSettled(
    tasks.map((task, i) => runAgent(cwd, base, gitCommonDir, worktrees[i]!, { ...opts, prompt: task.prompt }, `[${i}] `, i)),
  );

  const results: TaskResult[] = [];
  for (const [i, outcome] of outcomes.entries()) {
    const { prompt } = tasks[i]!;
    const { branch } = worktrees[i]!;
    if (outcome.status === "rejected") {
      const error = redact(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      const usage = outcome.reason instanceof AgentFailure ? outcome.reason.usage : undefined;
      results.push({ prompt, status: "failed", branch, commits: [], iterations: [], ...(usage ? { usage } : {}), error });
      continue;
    }
    const conflict = await mergeBack(cwd, branch, outcome.value.commits);
    results.push(
      conflict
        ? { prompt, status: "conflict", branch, ...outcome.value, error: conflict }
        : { prompt, status: "merged", branch, ...outcome.value },
    );
  }
  return results;
}

export interface ReviewOptions {
  prompt: string;
  /** Implements the task (and addresses feedback). */
  agent: Agent;
  /** Reviews each round. Defaults to `agent`. */
  reviewer?: Agent;
  sandbox: Sandbox;
  cwd?: string;
  /** Max implement → review rounds. Defaults to 2. */
  maxRounds?: number;
  /** Reviewer stdout containing this approves the change. Defaults to "<review>APPROVE</review>". */
  approveSignal?: string;
  /** Extra instruction appended to every reviewer prompt. */
  reviewerInstruction?: string;
  /** Shell command run in the worktree, inside `sandbox`, before the first agent run. Defaults to `.bunker/setup` if present. */
  setup?: string;
  /** Progress events: stages, agent text and tool calls, results. */
  onEvent?: OnEvent;
  /** Every raw stdout line of a streaming agent, redacted. */
  onRaw?: (line: string) => void;
}

export interface ReviewRound {
  /** Commits the implementer added this round. */
  commits: Commit[];
  approved: boolean;
  /** The reviewer's stdout. */
  feedback: string;
  /** The implementer's stdout. */
  output: string;
  /** Implementer + reviewer this round. */
  usage?: Usage;
}

export interface ReviewResult {
  status: "approved" | "rejected" | "failed" | "conflict";
  branch: string;
  commits: Commit[];
  rounds: ReviewRound[];
  /** Implementer + reviewer, all rounds, if the agents report it. */
  usage?: Usage;
  error?: string;
}

const DEFAULT_APPROVE = "<review>APPROVE</review>";

function reviewerPrompt(task: string, diff: string, approveSignal: string, extra?: string): string {
  return (
    `You are reviewing a change made for this task:\n\n${task}\n\n` +
    `Here is the full diff of the change:\n\n${diff}\n\n` +
    "Do not modify any files and do not commit anything. " +
    `If the change is acceptable, print ${approveSignal}. ` +
    "Otherwise list the changes that are required." +
    (extra ? `\n\n${extra}` : "")
  );
}

/**
 * Implement → review rounds in one worktree. The reviewer sees the task and the
 * full diff; whatever it changes or commits is discarded, so only the
 * implementer's commits survive. Approved → merged like run(). Otherwise
 * (rejected after maxRounds, failed, conflict) the result says so and the branch
 * is kept. Nothing is thrown for those outcomes.
 */
export async function review({
  cwd = process.cwd(),
  prompt,
  agent,
  reviewer = agent,
  sandbox,
  maxRounds = 2,
  approveSignal = DEFAULT_APPROVE,
  reviewerInstruction,
  setup,
  onEvent,
  onRaw,
}: ReviewOptions): Promise<ReviewResult> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const wt = await addWorktree(cwd, base);
  const ctx = { worktree: wt.path, gitCommonDir };
  const rounds: ReviewRound[] = [];
  let commits: Commit[] = [];
  const usages: (Usage | undefined)[] = [];
  let status: ReviewResult["status"] = "rejected";
  let error: string | undefined;
  try {
    emitStage({ onEvent }, "setup");
    const prep = await runSetup(sandbox, ctx, setup);
    if (prep && prep.code !== 0) throw new Error(`setup failed (exit ${prep.code}):\n${tailLines(prep.stdout)}`);
    for (let i = 0; i < maxRounds; i++) {
      const feedback = rounds.at(-1)?.feedback;
      const task = feedback === undefined ? prompt : `${prompt}\n\nA reviewer requested changes:\n${feedback}`;
      const implTarget = { onEvent, onRaw, round: i + 1, role: "implementer" as const };
      emitStage(implTarget, "implement");
      const implHook = lineHook(agent, implTarget);
      const impl = await sandbox.exec(agent.command(task, "write"), implHook ? { ...ctx, onLine: implHook } : ctx);
      const implOut = interpret(agent, impl.stdout);
      usages.push(implOut.usage);
      if (impl.code !== 0) throw new Error(`agent exited with ${impl.code}; work kept on ${wt.branch}`);
      const total = await commitsBetween(cwd, base, wt.branch);
      const added = total.slice(commits.length);
      commits = total;

      const head = (await $`git -C ${wt.path} rev-parse HEAD`.text()).trim();
      const diff = await $`git -C ${wt.path} diff ${base}..HEAD`.text();
      const revTarget = { onEvent, onRaw, round: i + 1, role: "reviewer" as const };
      emitStage(revTarget, "review");
      const revHook = lineHook(reviewer, revTarget);
      const rev = await sandbox.exec(reviewer.command(reviewerPrompt(prompt, diff, approveSignal, reviewerInstruction), "review"), revHook ? { ...ctx, onLine: revHook } : ctx);
      // Only the implementer's commits survive, whatever the reviewer did.
      await $`git -C ${wt.path} reset -q --hard ${head}`.quiet();
      await $`git -C ${wt.path} clean -qfd`.quiet();
      const revOut = interpret(reviewer, rev.stdout);
      usages.push(revOut.usage);
      if (rev.code !== 0) throw new Error(`reviewer exited with ${rev.code}; work kept on ${wt.branch}`);

      const approved = revOut.text.includes(approveSignal);
      const usage = sumUsage([implOut.usage, revOut.usage]);
      rounds.push({ commits: added, approved, feedback: revOut.text, output: implOut.text, ...(usage ? { usage } : {}) });
      if (approved) {
        status = "approved";
        break;
      }
    }
  } catch (e) {
    status = "failed";
    error = redact(e instanceof Error ? e.message : String(e));
  } finally {
    await $`git -C ${cwd} worktree remove --force ${wt.path}`.quiet();
  }
  if (status === "approved") {
    error = await mergeBack(cwd, wt.branch, commits);
    if (error) status = "conflict";
  }
  const usage = sumUsage(usages);
  return { status, branch: wt.branch, commits, rounds, ...(usage ? { usage } : {}), ...(error ? { error } : {}) };
}
