import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redact } from "./redact.ts";
import { committedCopies, copyIntoWorktree, copyPatterns, copyRejection } from "./copy.ts";
import { extractOutput, reportOutput, verdictOutput, type Report, type Verdict } from "./structured.ts";
import { output, tailLines } from "./output.ts";
import { emit, findSessionId, findUsageLimit, findStreamResult, parseClaudeStreamLine, type OnEvent, type Stage, type StreamEvent } from "./events.ts";
export type { BunkerEvent, OnEvent } from "./events.ts";
import { modelLabel } from "./models.ts";
import baseDockerfile from "../images/base/Dockerfile" with { type: "text" };

export type AgentMode = "write" | "review";

/** Turns a prompt into the command line that runs the agent. */
export interface Agent {
  /** "review" is a read-only pass over someone else's work; "write" (default) is expected to commit. */
  command(prompt: string, mode?: AgentMode, opts?: { resume?: string }): string[];
  /** The id of the conversation the command just ran, from its raw stdout. Omit if the agent has no resumable sessions. */
  sessionId?(stdout: string): string | undefined;
  /** Whether the command stopped on the plan's usage limit, and when it resets (epoch ms) if known. Omit if the agent has no such limit. */
  usageLimit?(stdout: string): { resetAt?: number } | undefined;
  /** Turns the command's raw stdout into the agent's text plus what the run cost. Omit if stdout is already the text. */
  parse?(stdout: string): { text: string; usage?: Usage };
  /** Turns one line of the command's stdout into progress events. Omit if stdout isn't a stream. */
  parseLine?(line: string): StreamEvent[];
  /** The model this agent runs, if one is set (otherwise the agent's own default). */
  model?: string;
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
  /** Host directory that is the agent's `~/.claude/projects`, where its session files land. Without it nothing is resumed. */
  readonly projectsDir?: string;
  exec(cmd: string[], ctx: ExecContext): Promise<ExecResult>;
}

/** Limits on one command: kill it when it goes quiet, or when it hangs after finishing. */
export interface ExecLimits {
  /** Kill after this long without any stdout. */
  idleMs?: number;
  /** Kill after this long in total (for steps that can be legitimately quiet, like setup and verify). */
  stepMs?: number;
  /** Grace after `done` first returns true: if the process hasn't exited by then, kill it and report success. */
  graceMs?: number;
  /** Told a window of the latest stdout; true once the command has said it is finished. */
  done?: (recent: string) => boolean;
}

export interface ExecContext {
  worktree: string;
  gitCommonDir: string;
  prefix?: string;
  onLine?: (line: string) => void;
  limits?: ExecLimits;
}

export interface ExecResult {
  code: number;
  stdout: string;
  /** Set when the command was killed for going quiet (`idle`) or for running too long (`step`). */
  timedOut?: "idle" | "step";
  /** Set when the command finished but hung, and was killed after the grace window; `code` is then 0. */
  hung?: boolean;
}

/** Timeouts for the agent steps and for setup/verify. */
export interface Timeouts {
  /** An agent or reviewer with no stdout for this long is killed and the step fails as `idle-timeout`. Defaults to 10 minutes. */
  idleTimeoutMs?: number;
  /** After the completion/approve signal or final `result` event, how long the process may linger before it is killed and counted as done. Defaults to 60 s. */
  completionTimeoutMs?: number;
  /** Setup and verify may be quiet: they get this overall limit instead. Defaults to 30 minutes. */
  stepTimeoutMs?: number;
}

export const DEFAULT_IDLE_MS = 10 * 60_000;
export const DEFAULT_COMPLETION_MS = 60_000;
export const DEFAULT_STEP_MS = 30 * 60_000;

/** Thrown when an agent or setup/verify step is killed for being quiet or running too long. */
export class IdleTimeout extends Error {}

/** The limits for an agent step; it counts as finished once it prints a stream `result` event or one of `signals`. */
function agentLimits(t: Timeouts, signals: string[]): ExecLimits {
  return {
    idleMs: t.idleTimeoutMs ?? DEFAULT_IDLE_MS,
    graceMs: t.completionTimeoutMs ?? DEFAULT_COMPLETION_MS,
    done: (recent) => /"type"\s*:\s*"result"/.test(recent) || signals.some((s) => s && recent.includes(s)),
  };
}

/** The limits for setup/verify, which can be quiet for long. */
export function stepLimits(t: Timeouts): ExecLimits {
  return { stepMs: t.stepTimeoutMs ?? DEFAULT_STEP_MS };
}

/** Why a step was killed. */
export function timeoutMessage(who: string, timedOut: "idle" | "step", t: Timeouts): string {
  return timedOut === "step"
    ? `${who} timed out after ${formatDuration(t.stepTimeoutMs ?? DEFAULT_STEP_MS)} (step timeout); killed`
    : `${who} produced no output for ${formatDuration(t.idleTimeoutMs ?? DEFAULT_IDLE_MS)} (idle timeout); killed`;
}

export interface Commit {
  sha: string;
  subject: string;
}

export interface RunOptions extends Timeouts {
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
  /** Continue the previous iteration's agent session instead of starting fresh. Defaults to true. */
  resume?: boolean;
  /** Host directory to keep the agent's session files in (`<role>-<round>.jsonl`). Defaults to a temporary one. */
  sessionsDir?: string;
  /** Host-relative paths or globs copied from `cwd` into the worktree (before setup), e.g. `.env`. Overrides the repo's `.bunker/copy`. Never committed. */
  copyToWorktree?: string[];
}

export interface Iteration {
  exitCode: number;
  /** The agent session this iteration ran in, if the agent reports one. */
  sessionId?: string;
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
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.json ? { parse: parseClaudeJson, parseLine: parseClaudeStreamLine } : {}),
    ...(opts.json ? { sessionId: findSessionId, usageLimit: findUsageLimit } : {}),
    command: (prompt, mode = "write", o) => [
      "claude",
      "-p",
      mode === "write" ? prompt + COMMIT_INSTRUCTION : prompt,
      "--dangerously-skip-permissions",
      ...(o?.resume ? ["--resume", o.resume] : []),
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
async function teeStdout(proc: Bun.Subprocess<"ignore", "pipe", "inherit">, prefix = "", onLine?: (line: string) => void, limits: ExecLimits = {}, kill: () => void = () => killGroup(proc)): Promise<ExecResult> {
  let timedOut: ExecResult["timedOut"];
  let hung = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (!limits.idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = "idle";
      kill();
    }, limits.idleMs);
  };
  const stepTimer = limits.stepMs
    ? setTimeout(() => {
        timedOut = "step";
        kill();
      }, limits.stepMs)
    : undefined;
  armIdle();
  let window = "";
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
    // Real output after a "done" match means the match was a mention, not the end: back to idle watching.
    if (graceTimer && text.trim()) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
      window = "";
    }
    if (!graceTimer) {
      armIdle();
      if (limits.done) {
        window = (window + text).slice(-Math.max(4096, 2 * text.length));
        if (limits.done(window)) {
          // Finished: silence no longer matters, only whether it exits within the grace window.
          clearTimeout(idleTimer);
          graceTimer = setTimeout(() => {
            hung = true;
            kill();
          }, limits.graceMs ?? DEFAULT_COMPLETION_MS);
        }
      }
    }
    const nl = pending.lastIndexOf("\n");
    if (nl >= 0) {
      out(pending.slice(0, nl + 1));
      pending = pending.slice(nl + 1);
    }
  }
  const tail = decoder.decode();
  stdout += tail;
  pending += tail;
  // Prefixed output is interleaved with other tasks': end the last line, or the next task's runs on after it.
  if (pending) out(prefix && !onLine ? `${pending}\n` : pending);
  const exited = await proc.exited;
  clearTimeout(idleTimer);
  clearTimeout(graceTimer);
  clearTimeout(stepTimer);
  // A command killed after it said it was done counts as a success.
  const graceKilled = hung && !timedOut;
  return { code: graceKilled ? 0 : exited, stdout: redact(stdout), ...(timedOut ? { timedOut } : {}), ...(graceKilled ? { hung } : {}) };
}

/** SIGKILLs the process's whole group (agents run detached, in their own group), so children die too. */
function killGroup(proc: Bun.Subprocess<any, any, any>) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
}

/** GitHub credentials bunker itself uses; an agent must never see them. */
export const GH_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "BUNKER_GH_TOKEN"] as const;

/** Runs the agent straight on the host, in the worktree. No isolation (GitHub tokens are stripped from its env). */
export function noSandbox(): Sandbox {
  return {
    // Read late: the agent uses whatever HOME is current.
    get projectsDir() {
      return join(process.env.HOME ?? tmpdir(), ".claude", "projects");
    },
    exec: (cmd, { worktree, prefix, onLine, limits }) =>
      // detached: own process group, so a terminal Ctrl-C reaches only bunker, which lets the step finish.
      // Explicit env: Bun.spawn otherwise passes the startup environment, dropping
      // anything set at runtime (e.g. the token loaded from .bunker/.env).
      teeStdout(Bun.spawn(cmd, { cwd: worktree, env: agentEnv(), stdio: ["ignore", "pipe", "inherit"], detached: true }), prefix, onLine, limits),
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
    async exec(cmd, { worktree, gitCommonDir, prefix, onLine, limits }) {
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
        bin, "run", "--rm", "--name", cname,
        ...userArgs,
        "-e", "HOME=/tmp",
        ...env.flatMap((name) => ["-e", name]), // name only: value comes from our env, never argv
        ...identity,
        "-v", `${this.projectsDir}:/tmp/.claude/projects`,
        "-v", `${worktree}:${worktree}`,
        "-v", `${gitCommonDir}:${gitCommonDir}`,
        "-w", worktree,
        "--entrypoint", entrypoint,
        image,
        ...args,
      ];
      const proc = Bun.spawn(argv, { env: process.env, stdio: ["ignore", "pipe", "inherit"], detached: true });
      // Killing the CLI client would leave the container running; stop the container itself too.
      const kill = () => {
        Bun.spawn([bin, "kill", cname], { stdio: ["ignore", "ignore", "ignore"] });
        killGroup(proc);
      };
      return teeStdout(proc, prefix, onLine, limits, kill);
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
  timeouts: Timeouts = {},
): Promise<{ cmd: string; code: number; stdout: string; timedOut?: "idle" | "step" } | undefined> {
  const cmd = setup ?? ((await Bun.file(join(ctx.worktree, ".bunker", "setup")).exists()) ? "sh .bunker/setup" : undefined);
  if (!cmd) return undefined;
  const out = await sandbox.exec(["sh", "-c", `(${cmd}) 2>&1`], { ...ctx, limits: stepLimits(timeouts) });
  return { cmd, ...out };
}

let worktreeAdminTail: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` (git worktree add/remove, branch -D) after this process's earlier such commands. They read every worktree's
 * admin dir under .git/worktrees, so one running beside a `worktree add` can read it half-written and fail
 * ("failed to read .../commondir"), as parallel queue slots did.
 */
export function worktreeAdmin<T>(fn: () => Promise<T>): Promise<T> {
  const run = worktreeAdminTail.then(fn);
  worktreeAdminTail = run.catch(() => {});
  return run;
}

async function addWorktree(cwd: string, base: string): Promise<Worktree> {
  const id = crypto.randomUUID().slice(0, 8);
  const wt = { branch: `bunker/${id}`, path: join(tmpdir(), `bunker-${id}`) };
  await worktreeAdmin(() => $`git -C ${cwd} worktree add -q -b ${wt.branch} ${wt.path} ${base}`);
  return wt;
}

/** Copies the patterns (default: .bunker/copy) into the fresh worktree; on failure removes the worktree and branch. */
async function copyInto(cwd: string, wt: Worktree, patterns: string[]): Promise<string[]> {
  try {
    return await copyIntoWorktree(cwd, wt.path, patterns);
  } catch (e) {
    await worktreeAdmin(() => $`git -C ${cwd} worktree remove --force ${wt.path}`.nothrow().quiet());
    await worktreeAdmin(() => $`git -C ${cwd} branch -D ${wt.branch}`.nothrow().quiet());
    throw e;
  }
}

/** Where an agent run's events are labelled from, and where raw stdout lines go. */
export interface EventTarget {
  onEvent?: OnEvent | undefined;
  /** Every raw stdout line of a streaming agent (already redacted). */
  onRaw?: ((line: string) => void) | undefined;
  task?: number;
  round?: number;
  role?: "implementer" | "reviewer" | "auditor";
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

export function emitStage(t: Pick<EventTarget, "onEvent" | "task" | "round" | "role">, name: Stage, text?: string, model?: string) {
  emit(t.onEvent, { type: "stage", name, ...(model ? { model } : {}), ...(t.task !== undefined ? { task: t.task } : {}), ...(t.round !== undefined ? { round: t.round } : {}), ...(t.role ? { role: t.role } : {}), ...(text ? { text } : {}) });
}

/** Where a run stopped on the usage limit, so it can be picked up again. JSON-serialisable. */
export interface Pause {
  /** Epoch ms the limit resets, when the agent said. */
  resetAt?: number;
  role: "implementer" | "reviewer";
  /** 1-based review round. */
  round: number;
  sessionId?: string;
  /** Host copy of the session file. */
  sessionFile?: string;
  /** The review worktree and branch holding the work so far. */
  worktree: string;
  branch: string;
  /** With role `reviewer`: the implementer's output and session this round. */
  implOutput?: string;
  implSessionId?: string;
  rounds: ReviewRound[];
}

/** Thrown inside a step when the agent hit the usage limit. */
class UsageLimit extends Error {
  constructor(readonly resetAt: number | undefined, readonly session: Session | undefined) {
    super("claude usage limit reached");
  }
}

/** A failed agent run; carries the usage already spent. */
export class AgentFailure extends Error {
  constructor(message: string, readonly usage?: Usage) {
    super(message);
  }
}

interface Session {
  id: string;
  /** Saved copy on the host. */
  file: string;
}

/** Saves session `id` from the sandbox's store to `dest`, plus a redacted copy next to it. */
async function captureSession(sandbox: Sandbox, id: string, dest: string): Promise<Session | undefined> {
  const root = sandbox.projectsDir;
  if (!root) return undefined;
  try {
    for (const dir of await readdir(root)) {
      const file = Bun.file(join(root, dir, `${id}.jsonl`));
      if (!(await file.exists())) continue;
      const text = await file.text();
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, text);
      await Bun.write(dest.replace(/\.jsonl$/, ".redacted.jsonl"), redact(text));
      return { id, file: dest };
    }
  } catch {}
  return undefined;
}

/** Puts a saved session back where claude (running in `worktree`) looks for it. */
async function restoreSession(sandbox: Sandbox, worktree: string, session: Session): Promise<void> {
  const root = sandbox.projectsDir;
  if (!root) throw new Error("sandbox has no session store");
  const dir = join(root, worktree.replace(/[^a-zA-Z0-9]/g, "-"));
  const target = join(dir, `${session.id}.jsonl`);
  if (await Bun.file(target).exists()) return;
  await mkdir(dir, { recursive: true });
  await Bun.write(target, Bun.file(session.file));
}

/**
 * Runs one agent command. With `prev`, first restores that session and resumes it with `resumePrompt`;
 * if that can't be done or the resumed run fails, says so and runs `prompt` in a fresh session instead.
 * The session the final run used is saved to `dest`.
 */
async function agentStep(o: {
  agent: Agent;
  sandbox: Sandbox;
  mode: AgentMode;
  prompt: string;
  resumePrompt?: string;
  prev?: Session | undefined;
  ctx: ExecContext;
  target: Pick<EventTarget, "onEvent" | "task" | "round" | "role">;
  dest: string;
  timeouts?: Timeouts;
  /** Output that marks the agent as finished, besides a stream `result` event. */
  signals?: string[];
}): Promise<{ code: number; stdout: string; session?: Session }> {
  const timeouts = o.timeouts ?? {};
  const label = { ...(o.target.task !== undefined ? { task: o.target.task } : {}), ...(o.target.round !== undefined ? { round: o.target.round } : {}), ...(o.target.role ? { role: o.target.role } : {}) };
  const ctx: ExecContext = { ...o.ctx, limits: agentLimits(timeouts, o.signals ?? []) };
  /** Runs the command; a killed one throws IdleTimeout, a hung-but-finished one is noted and counts as done. */
  const exec = async (cmd: string[]) => {
    const r = await o.sandbox.exec(cmd, ctx);
    if (r.timedOut) throw new IdleTimeout(timeoutMessage(o.target.role ?? "agent", r.timedOut, timeouts));
    if (r.hung) emit(o.target.onEvent, { type: "note", ...label, text: `warning: agent did not exit ${formatDuration(timeouts.completionTimeoutMs ?? DEFAULT_COMPLETION_MS)} after finishing; killed it and treating the step as completed` });
    return r;
  };
  let res: { code: number; stdout: string } | undefined;
  if (o.prev) {
    const fallback = (why: string) =>
      emit(o.target.onEvent, { type: "note", ...(o.target.task !== undefined ? { task: o.target.task } : {}), ...(o.target.round !== undefined ? { round: o.target.round } : {}), ...(o.target.role ? { role: o.target.role } : {}), text: `could not resume session ${o.prev!.id} (${why}); starting a fresh session` });
    try {
      await restoreSession(o.sandbox, o.ctx.worktree, o.prev);
      res = await exec(o.agent.command(o.resumePrompt ?? o.prompt, o.mode, { resume: o.prev.id }));
      if (res.code !== 0 && !o.agent.usageLimit?.(res.stdout)) {
        fallback(`exit ${res.code}`);
        res = undefined;
      }
    } catch (e) {
      if (e instanceof IdleTimeout) throw e;
      fallback(redact(e instanceof Error ? e.message : String(e)));
    }
  }
  res ??= await exec(o.agent.command(o.prompt, o.mode));
  const id = o.agent.sessionId?.(res.stdout);
  const session = id ? await captureSession(o.sandbox, id, o.dest) : undefined;
  const limit = o.agent.usageLimit?.(res.stdout);
  if (limit) throw new UsageLimit(limit.resetAt, session ?? (id ? { id, file: "" } : undefined));
  return { ...res, ...(session ? { session } : {}) };
}

/** Keeps sessions in `dir`, or in a temp dir that `done()` removes. */
async function sessionStore(dir?: string): Promise<{ dir: string; done: () => Promise<void> }> {
  if (dir) return { dir, done: async () => {} };
  const tmp = await mkdtemp(join(tmpdir(), "bunker-sessions-"));
  return { dir: tmp, done: () => rm(tmp, { recursive: true, force: true }) };
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
  { prompt, agent, sandbox, maxIterations = 1, completionSignal = DEFAULT_SIGNAL, onEvent, resume = true, sessionsDir, ...timeouts }: Omit<RunOptions, "cwd" | "copyToWorktree">,
  prefix?: string,
  task?: number,
  copied: string[] = [],
): Promise<AgentOutcome> {
  const signals = [completionSignal].flat();
  const iterations: Iteration[] = [];
  let commits: Commit[] = [];
  const store = await sessionStore(sessionsDir);
  let prev: Session | undefined;
  try {
    for (let i = 0; i < maxIterations; i++) {
      const target = { onEvent, task, round: i + 1, role: "implementer" as const };
      emitStage(target, "implement", undefined, modelLabel(agent));
      const onLine = lineHook(agent, target);
      const step = await agentStep({
        agent, sandbox, mode: "write", prompt, prev: resume ? prev : undefined, target,
        ctx: { worktree: wt.path, gitCommonDir, ...(prefix ? { prefix } : {}), ...(onLine ? { onLine } : {}) },
        dest: join(store.dir, `implementer-${i + 1}.jsonl`), timeouts, signals,
      });
      const { code, stdout } = step;
      prev = step.session;
      const { text, usage } = interpret(agent, stdout);
      if (code !== 0) {
        throw new AgentFailure(`agent exited with ${code}; work kept on ${wt.branch}`, sumUsage([...iterations.map((i) => i.usage), usage]));
      }
      const staged = await committedCopies(wt.path, base, copied);
      if (staged.length) throw new AgentFailure(`${copyRejection(staged)}; work kept on ${wt.branch}`, sumUsage([...iterations.map((i) => i.usage), usage]));
      const total = await commitsBetween(cwd, base, wt.branch);
      iterations.push({ exitCode: code, commits: total.slice(commits.length), ...(step.session ? { sessionId: step.session.id } : {}), ...(usage ? { usage } : {}) });
      commits = total;
      const matched = signals.find((s) => text.includes(s));
      if (matched) return { commits, iterations, completionSignal: matched, ...totalUsage(iterations) };
    }
    return { commits, iterations, ...totalUsage(iterations) };
  } finally {
    await store.done();
    await worktreeAdmin(() => $`git -C ${cwd} worktree remove --force ${wt.path}`.quiet());
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
export async function run({ cwd = process.cwd(), copyToWorktree, ...opts }: RunOptions): Promise<RunResult> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const patterns = await copyPatterns(cwd, copyToWorktree);
  const wt = await addWorktree(cwd, base);
  const copied = await copyInto(cwd, wt, patterns);
  const outcome = await runAgent(cwd, base, gitCommonDir, wt, opts, undefined, undefined, copied);
  const conflict = await mergeBack(cwd, wt.branch, outcome.commits);
  if (conflict) throw new Error(conflict);
  return { branch: wt.branch, ...outcome };
}

export interface RunAllOptions extends Timeouts {
  tasks: { prompt: string }[];
  agent: Agent;
  sandbox: Sandbox;
  cwd?: string;
  /** Per task, as in run(). */
  maxIterations?: number;
  completionSignal?: string | string[];
  onEvent?: OnEvent;
  /** As in run(). */
  resume?: boolean;
  /** As in run(). */
  copyToWorktree?: string[];
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
export async function runAll({ tasks, cwd = process.cwd(), copyToWorktree, ...opts }: RunAllOptions): Promise<TaskResult[]> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  const patterns = await copyPatterns(cwd, copyToWorktree);
  const worktrees: Worktree[] = [];
  const copies: string[][] = [];
  for (const _ of tasks) {
    const wt = await addWorktree(cwd, base);
    worktrees.push(wt);
    copies.push(await copyInto(cwd, wt, patterns));
  }

  const outcomes = await Promise.allSettled(
    tasks.map((task, i) => runAgent(cwd, base, gitCommonDir, worktrees[i]!, { ...opts, prompt: task.prompt }, `[${i}] `, i, copies[i])),
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

export interface ReviewOptions extends Timeouts {
  prompt: string;
  /** Implements the task (and addresses feedback). */
  agent: Agent;
  /** Reviews each round. Defaults to `agent`. */
  reviewer?: Agent;
  sandbox: Sandbox;
  cwd?: string;
  /** Max implement → review rounds. Defaults to 2. */
  maxRounds?: number;
  /** Legacy fallback, used only when the reviewer printed no `<verdict>` at all: stdout containing this approves. Defaults to "<review>APPROVE</review>". */
  approveSignal?: string;
  /** Times to re-ask the reviewer (resuming its session) for a missing or invalid `<verdict>`. Defaults to 2. */
  maxRetries?: number;
  /** Extra instruction appended to every reviewer prompt. */
  reviewerInstruction?: string;
  /** Shell command run in the worktree, inside `sandbox`, before the first agent run. Defaults to `.bunker/setup` if present. */
  setup?: string;
  /** Progress events: stages, agent text and tool calls, results. */
  onEvent?: OnEvent;
  /** Every raw stdout line of a streaming agent, redacted. */
  onRaw?: (line: string) => void;
  /** Resume the implementer's session across rounds (reviewers always start fresh). Defaults to true. */
  resume?: boolean;
  /** Host directory to keep agent session files in (`<role>-<round>.jsonl`). Defaults to a temporary one. */
  sessionsDir?: string;
  /** As in run(), copied before setup. */
  copyToWorktree?: string[];
  /** Continue a run that stopped on the usage limit (a `pause` from an earlier result): same worktree and branch, same step, same session. */
  resumeFrom?: Pause;
}

export interface ReviewRound {
  /** The implementer's agent session this round, if the agent reports one. */
  sessionId?: string;
  /** Commits the implementer added this round. */
  commits: Commit[];
  approved: boolean;
  /** The reviewer's stdout. */
  feedback: string;
  /** The reviewer's structured verdict, absent when only the legacy approve signal was used. */
  verdict?: Verdict;
  /** The implementer's structured `<report>`, if it printed a valid one. */
  report?: Report;
  /** Why the implementer's `<report>` was ignored, when it printed one that was invalid. */
  reportError?: string;
  /** The implementer's stdout. */
  output: string;
  /** Implementer + reviewer this round. */
  usage?: Usage;
}

export interface ReviewResult {
  status: "approved" | "rejected" | "failed" | "conflict" | "bad-output" | "idle-timeout" | "paused-usage-limit";
  branch: string;
  commits: Commit[];
  rounds: ReviewRound[];
  /** With status `paused-usage-limit`: the worktree and branch are kept; pass this as `resumeFrom` to continue. */
  pause?: Pause;
  /** Implementer + reviewer, all rounds, if the agents report it. */
  usage?: Usage;
  error?: string;
}

const DEFAULT_APPROVE = "<review>APPROVE</review>";

const VERDICT_FORMAT =
  'end your answer with <verdict>{"approved": true|false, "required_changes": ["…"], "issues": [{"title": "…", "body": "…"}], "blocked_by": [{"title": "…", "body": "…"}]}</verdict>: ' +
  "valid JSON, `approved` true only if the change is acceptable, `required_changes` what must change otherwise. " +
  "Only the last <verdict> in your answer counts.";

class BadOutput extends Error {}

function reviewerPrompt(task: string, diff: string, extra?: string, approveSignal = DEFAULT_APPROVE): string {
  return (
    `You are reviewing a change made for this task:\n\n${task}\n\n` +
    `Here is the full diff of the change:\n\n${diff}\n\n` +
    "Do not modify any files and do not commit anything. " +
    `Review it, then ${VERDICT_FORMAT}` +
    (approveSignal !== DEFAULT_APPROVE ? ` If you approve, you may instead print ${approveSignal} on its own.` : "") +
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
  maxRetries = 2,
  reviewerInstruction,
  setup,
  onEvent,
  onRaw,
  resume = true,
  sessionsDir,
  copyToWorktree,
  resumeFrom,
  ...timeouts
}: ReviewOptions): Promise<ReviewResult> {
  const { base, gitCommonDir } = await repoInfo(cwd);
  let wt: Worktree;
  if (resumeFrom) {
    wt = { branch: resumeFrom.branch, path: resumeFrom.worktree };
    // A cleaned-up temp dir loses uncommitted work, but the branch's commits are still there.
    if (!existsSync(wt.path)) await worktreeAdmin(() => $`git -C ${cwd} worktree add -q ${wt.path} ${wt.branch}`);
  } else {
    wt = await addWorktree(cwd, base);
  }
  const ctx = { worktree: wt.path, gitCommonDir };
  const rounds: ReviewRound[] = resumeFrom ? [...resumeFrom.rounds] : [];
  let pause: Pause | undefined;
  let commits: Commit[] = [];
  const usages: (Usage | undefined)[] = [];
  let status: ReviewResult["status"] = "rejected";
  let error: string | undefined;
  const store = await sessionStore(sessionsDir);
  let prev: Session | undefined;
  let copied: string[] = [];
  /** The step in flight, for the pause record. */
  let step: { role: "implementer" | "reviewer"; round: number; implOutput?: string; implSessionId?: string } = { role: "implementer", round: 1 };
  const reviewSignals = [approveSignal, "</verdict>"];
  try {
    copied = await copyIntoWorktree(cwd, wt.path, await copyPatterns(cwd, copyToWorktree));
    if (!resumeFrom) {
      emitStage({ onEvent }, "setup");
      const prep = await runSetup(sandbox, ctx, setup, timeouts);
      if (prep?.timedOut) throw new IdleTimeout(timeoutMessage("setup", prep.timedOut, timeouts));
      if (prep && prep.code !== 0) throw new Error(`setup failed (exit ${prep.code}):\n${tailLines(prep.stdout)}`);
    }
    // Resuming: the interrupted step continues its session; every earlier one is already in `rounds`.
    let resuming = resumeFrom;
    const savedSession = resumeFrom?.sessionId && resumeFrom.sessionFile ? { id: resumeFrom.sessionId, file: resumeFrom.sessionFile } : undefined;
    commits = resumeFrom ? await commitsBetween(cwd, base, wt.branch) : commits;
    for (let i = resumeFrom ? resumeFrom.round - 1 : 0; i < maxRounds; i++) {
      const feedback = rounds.at(-1)?.feedback;
      const CONTINUE = "Your session stopped on the Claude usage limit, which has now reset. Continue where you left off and finish the task.";
      const skipImpl = resuming?.role === "reviewer";
      step = { role: "implementer", round: i + 1 };
      const task = feedback === undefined ? prompt : `${prompt}\n\nA reviewer requested changes:\n${feedback}`;
      const implTarget = { onEvent, onRaw, round: i + 1, role: "implementer" as const };
      emitStage(implTarget, "implement", undefined, modelLabel(agent));
      const implHook = lineHook(agent, implTarget);
      let impl: { code: number; stdout: string; session?: Session };
      let implOut: { text: string; usage?: Usage };
      let added: Commit[] = [];
      if (skipImpl) {
        impl = { code: 0, stdout: "", ...(resumeFrom!.implSessionId ? { session: { id: resumeFrom!.implSessionId, file: join(store.dir, `implementer-${i + 1}.jsonl`) } } : {}) };
        implOut = { text: resumeFrom!.implOutput ?? "" };
      } else {
        const resumed = resuming?.role === "implementer" ? resuming : undefined;
        impl = await agentStep({
          agent, sandbox, mode: "write", prompt: task, target: implTarget,
          ...(resumed ? { resumePrompt: CONTINUE } : feedback !== undefined ? { resumePrompt: `A reviewer requested changes:\n${feedback}` } : {}),
          prev: resumed ? savedSession : resume ? prev : undefined,
          ctx: implHook ? { ...ctx, onLine: implHook } : ctx,
          dest: join(store.dir, `implementer-${i + 1}.jsonl`), timeouts, signals: [],
        });
        prev = impl.session;
        implOut = interpret(agent, impl.stdout);
        usages.push(implOut.usage);
        if (impl.code !== 0) throw new Error(`agent exited with ${impl.code}; work kept on ${wt.branch}`);
        const staged = await committedCopies(wt.path, base, copied);
        if (staged.length) throw new Error(`${copyRejection(staged)}; work kept on ${wt.branch}`);
        const total = await commitsBetween(cwd, base, wt.branch);
        added = total.slice(commits.length);
        commits = total;
      }
      step = { role: "reviewer", round: i + 1, implOutput: implOut.text, ...(impl.session ? { implSessionId: impl.session.id } : {}) };

      const head = (await $`git -C ${wt.path} rev-parse HEAD`.text()).trim();
      const diff = await $`git -C ${wt.path} diff ${base}..HEAD`.text();
      const revTarget = { onEvent, onRaw, round: i + 1, role: "reviewer" as const };
      emitStage(revTarget, "review", undefined, modelLabel(reviewer));
      const revHook = lineHook(reviewer, revTarget);
      // Reviewers never resume: each review is independent.
      const revPrompt = reviewerPrompt(prompt, diff, reviewerInstruction, approveSignal);
      const revResumed = resuming?.role === "reviewer" ? savedSession : undefined;
      resuming = undefined;
      let rev = await agentStep({
        agent: reviewer, sandbox, mode: "review", prompt: revPrompt, target: revTarget,
        ...(revResumed ? { prev: revResumed, resumePrompt: "Your session stopped on the Claude usage limit, which has now reset. Continue the review and finish it." } : {}),
        ctx: revHook ? { ...ctx, onLine: revHook } : ctx,
        dest: join(store.dir, `reviewer-${i + 1}.jsonl`), timeouts, signals: reviewSignals,
      });
      let revOut = interpret(reviewer, rev.stdout);
      const attempts: (Usage | undefined)[] = [];
      let parsed = extractOutput(revOut.text, verdictOutput);
      // A reviewer that never heard of <verdict> may still say the old approve signal; that stays a fallback.
      const legacy = (text: string, p: typeof parsed) => !p.ok && !p.present && text.includes(approveSignal);
      for (let k = 1; rev.code === 0 && !parsed.ok && !legacy(revOut.text, parsed) && k <= maxRetries; k++) {
        attempts.push(revOut.usage);
        const ask = `Your answer had no usable verdict (${parsed.error}). Reply again, ${VERDICT_FORMAT}`;
        rev = await agentStep({
          agent: reviewer, sandbox, mode: "review", prompt: `${revPrompt}\n\n${ask}`, resumePrompt: ask, prev: rev.session, target: revTarget,
          ctx: revHook ? { ...ctx, onLine: revHook } : ctx,
          dest: join(store.dir, `reviewer-${i + 1}-retry${k}.jsonl`), timeouts, signals: reviewSignals,
        });
        revOut = interpret(reviewer, rev.stdout);
        parsed = extractOutput(revOut.text, verdictOutput);
      }
      // Only the implementer's commits survive, whatever the reviewer did.
      await $`git -C ${wt.path} reset -q --hard ${head}`.quiet();
      await $`git -C ${wt.path} clean -qfd`.quiet();
      attempts.push(revOut.usage);
      usages.push(...attempts);
      if (rev.code !== 0) throw new Error(`reviewer exited with ${rev.code}; work kept on ${wt.branch}`);
      if (!parsed.ok && !legacy(revOut.text, parsed)) throw new BadOutput(`reviewer gave bad output after ${maxRetries} retries: ${parsed.error}; work kept on ${wt.branch}`);

      const verdict = parsed.ok ? parsed.value : undefined;
      const approved = verdict ? verdict.approved : true;
      const reported = extractOutput(implOut.text, reportOutput);
      const reportError = reported.ok || !reported.present ? undefined : reported.error;
      if (reportError) emit(onEvent, { type: "note", round: i + 1, role: "implementer", text: `ignoring the implementer's <report>: ${reportError}` });
      const changes = verdict && !verdict.approved && verdict.required_changes.length ? verdict.required_changes.map((c) => `- ${c}`).join("\n") + "\n\n" : "";
      const usage = sumUsage([implOut.usage, ...attempts]);
      rounds.push({ ...(impl.session ? { sessionId: impl.session.id } : {}), commits: added, approved, feedback: changes + revOut.text, ...(verdict ? { verdict } : {}), ...(reported.ok ? { report: reported.value } : {}), ...(reportError ? { reportError } : {}), output: implOut.text, ...(usage ? { usage } : {}) });
      if (approved) {
        status = "approved";
        break;
      }
    }
  } catch (e) {
    if (e instanceof UsageLimit) {
      status = "paused-usage-limit";
      error = e.message;
      // The session was captured into the store's dest; the caller's sessionsDir keeps it.
      pause = {
        ...(e.resetAt !== undefined ? { resetAt: e.resetAt } : {}), role: step.role, round: step.round,
        ...(e.session ? { sessionId: e.session.id, ...(e.session.file ? { sessionFile: e.session.file } : {}) } : {}),
        worktree: wt.path, branch: wt.branch, rounds,
        ...(step.implOutput !== undefined ? { implOutput: step.implOutput } : {}),
        ...(step.implSessionId ? { implSessionId: step.implSessionId } : {}),
      };
    } else {
      status = e instanceof BadOutput ? "bad-output" : e instanceof IdleTimeout ? "idle-timeout" : "failed";
      error = redact(e instanceof Error ? e.message : String(e));
    }
  } finally {
    await store.done();
    // A paused run keeps its worktree: whatever the agent had not committed yet is the work.
    if (!pause) await worktreeAdmin(() => $`git -C ${cwd} worktree remove --force ${wt.path}`.quiet());
  }
  if (status === "approved") {
    error = await mergeBack(cwd, wt.branch, commits);
    if (error) status = "conflict";
  }
  const usage = sumUsage(usages);
  return { status, branch: wt.branch, commits, rounds, ...(usage ? { usage } : {}), ...(pause ? { pause } : {}), ...(error ? { error } : {}) };
}
