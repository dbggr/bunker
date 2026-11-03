import { $ } from "bun";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildCommit, buildLabel, bunkerHome } from "../../build-info.ts";
import { defaultBranchOf, pullBlocker, safePull } from "../../github/pull.ts";
import { escapePath, unescapePath } from "../../mcp/server.ts";
import { alive } from "./watch.ts";
import pkg from "../../../package.json" with { type: "json" };

/** Where the new binary goes: the running binary if it is one and writable, else ~/.local/bin/bunker. */
export function installTarget(execPath = process.execPath): string {
  if (basename(execPath) === "bunker") {
    try {
      accessSync(dirname(execPath), constants.W_OK);
      return execPath;
    } catch {}
  }
  return join(homedir(), ".local", "bin", "bunker");
}

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The highest `vX.Y.Z` tag in `home` (other tags and prereleases are ignored); undefined if there is none. */
export async function latestTag(home: string): Promise<string | undefined> {
  const out = await $`git -C ${home} tag --list ${"v*"}`.nothrow().quiet().text();
  const parsed = out.split("\n").flatMap((line) => {
    const t = line.trim();
    const m = SEMVER_TAG.exec(t);
    return m ? [{ t, n: [Number(m[1]), Number(m[2]), Number(m[3])] as const }] : [];
  });
  parsed.sort((a, b) => a.n[0] - b.n[0] || a.n[1] - b.n[1] || a.n[2] - b.n[2]);
  return parsed.at(-1)?.t;
}

/** Builds the tree in `dir` (for the bunker checkout `home`) and returns the path of the compiled binary. */
export type BuildFn = (dir: string, home: string) => Promise<string | undefined>;

const realBuild: BuildFn = async (dir, home) => {
  for (const cmd of [["bun", "install", "--frozen-lockfile"], ["bun", "run", "build"]]) {
    const r = Bun.spawnSync(cmd, { cwd: dir, stdout: "inherit", stderr: "inherit", env: { ...process.env, BUNKER_BUILD_HOME: home } });
    if (r.exitCode !== 0) {
      console.error(`bunker: self-update: \`${cmd.join(" ")}\` failed`);
      return undefined;
    }
  }
  return join(dir, "dist", "bunker");
};

export interface SelfUpdateOptions {
  /** `release` (default): the latest v* tag. `main`: pull the checkout's default branch. */
  channel?: string;
  home?: string;
  target?: string;
  build?: BuildFn;
  /** Drain the running watch (finish its current steps, start no new work) instead of refusing, then restart it. */
  whenIdle?: boolean;
  /** With `whenIdle`: also drain and restart every active bunker watch unit on the machine. */
  restartAll?: boolean;
  watches?: WatchControl;
  /** Install even when the target is behind (or has diverged from) the installed build, or is the same commit. */
  force?: boolean;
  /** The build being replaced (default: this one). */
  installed?: InstalledBuild;
}

/** How self-update finds, drains and restarts watches. */
export interface WatchControl {
  /** Repos of the active `bunker-watch@` systemd user units. */
  units(): Promise<string[]>;
  /** SIGTERM the watch (finish in-flight steps, no new work) and wait for it to exit; false if it did not. */
  stop(pid: number): Promise<boolean>;
  restartUnit(repo: string): Promise<boolean>;
}

/** The PID in `<repo>/.bunker/watch.lock` when that watch is alive. */
function watchPid(repo: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(repo, ".bunker", "watch.lock"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function liveWatches(): WatchControl {
  const systemctl = async (...args: string[]) => {
    try {
      const p = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out };
    } catch {
      return { code: 127, out: "" };
    }
  };
  return {
    units: async () => {
      const r = await systemctl("list-units", "--plain", "--no-legend", "bunker-watch@*.service");
      return r.out.split("\n").flatMap((line) => {
        const m = line.trim().match(/^bunker-watch@(\S+)\.service\s+\S+\s+active/);
        return m ? [unescapePath(m[1]!)] : [];
      });
    },
    stop: async (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      // Unbounded on purpose: steps have their own timeouts, and Ctrl-C abandons the wait.
      while (alive(pid)) await sleep(1000);
      return true;
    },
    restartUnit: async (repo) => (await systemctl("restart", `bunker-watch@${escapePath(repo)}.service`)).code === 0,
  };
}

function install(bin: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  // Rename over the target: a running binary can't be written to, but it can be replaced.
  const tmp = `${target}.new-${process.pid}`;
  copyFileSync(bin, tmp);
  renameSync(tmp, target);
}

/** The build being replaced. `commit` is absent for binaries built before it was recorded; it is then found from `label`. */
export interface InstalledBuild {
  version: string;
  /** `vX.Y.Z` or `main@<sha>`. */
  label: string;
  commit?: string;
}

/** What the channel would build: the latest release tag's commit, or origin's default branch. */
interface UpdateTarget {
  commit: string;
  /** `vX.Y.Z`, or `main@<sha>`. */
  label: string;
  /** package.json's version at `commit`. */
  version: string;
}

const git = (home: string, ...args: string[]) => $`git -C ${home} ${args}`.nothrow().quiet();

const versionAt = async (home: string, commit: string) => {
  try {
    return JSON.parse((await git(home, "show", `${commit}:package.json`)).stdout.toString()).version as string;
  } catch {
    return "unknown";
  }
};

/** The full commit `rev` names in `home`, or undefined if `home` doesn't have it. */
const resolveCommit = async (home: string, rev: string) => {
  const r = await git(home, "rev-parse", "--verify", "-q", `${rev}^{commit}`);
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
};

/** Fetches and finds what the channel would install; an exit code when there is nothing to install. */
async function resolveTarget(channel: string, home: string): Promise<UpdateTarget | number> {
  if (channel === "main") {
    const branch = await defaultBranchOf(home);
    if ((await git(home, "fetch", "-q", "origin")).exitCode !== 0) console.error(`bunker: self-update: couldn't fetch origin; using the local origin/${branch}`);
    const commit = await resolveCommit(home, `refs/remotes/origin/${branch}`);
    if (!commit) {
      console.error(`bunker: self-update: no origin/${branch} in ${home}`);
      return 2;
    }
    return { commit, label: `main@${commit.slice(0, 7)}`, version: await versionAt(home, commit) };
  }
  const fetched = await git(home, "fetch", "--tags", "--force", "-q", "origin");
  if (fetched.exitCode !== 0) console.error("bunker: self-update: couldn't fetch tags from origin; using local tags");
  const tag = await latestTag(home);
  const commit = tag && (await resolveCommit(home, `refs/tags/${tag}`));
  if (!tag || !commit) {
    console.error("bunker: self-update: no v* release tags found (use --channel main to track main)");
    return 2;
  }
  return { commit, label: tag, version: await versionAt(home, commit) };
}

export type Direction = "same" | "update" | "downgrade" | "diverged" | "unknown";

/** How `target` relates to `installed` in `home`'s history. */
export async function direction(home: string, installed: string | undefined, target: string): Promise<Direction> {
  if (!installed) return "unknown";
  if (installed === target) return "same";
  const isAncestor = async (a: string, b: string) => (await git(home, "merge-base", "--is-ancestor", a, b)).exitCode === 0;
  if (await isAncestor(installed, target)) return "update";
  if (await isAncestor(target, installed)) return "downgrade";
  return "diverged";
}

/** `vX.Y.Z` for a release build, else `X.Y.Z (main@<sha>)`. */
const named = (v: string, label: string) => (SEMVER_TAG.test(label) || v === "unknown" ? label : `${v} (${label})`);

async function currentBuild(): Promise<InstalledBuild> {
  return { version: pkg.version, label: await buildLabel(), commit: await buildCommit() };
}

/** Rebuilds and reinstalls bunker: the latest release tag, or (`channel: "main"`) a pull of main. Returns the exit code. */
export async function selfUpdate(opts: SelfUpdateOptions = {}): Promise<number> {
  const channel = opts.channel ?? "release";
  if (channel !== "release" && channel !== "main") {
    console.error(`bunker: self-update: unknown channel "${channel}" (use release or main)`);
    return 2;
  }
  const home = opts.home ?? bunkerHome();
  const build = opts.build ?? realBuild;
  if (!existsSync(join(home, ".git"))) {
    console.error(`bunker: self-update: ${home} is not a git checkout (set BUNKER_HOME to your bunker checkout)`);
    return 2;
  }
  if (channel === "main") {
    const blocker = await pullBlocker(home);
    if (blocker) {
      console.error(`bunker: self-update refused in ${home}: ${blocker}`);
      return 2;
    }
  }
  const watches = opts.watches ?? liveWatches();
  const stopped: Stopped[] = [];
  const own = watchPid(home);
  if (own && !opts.whenIdle) {
    console.error(`bunker: self-update refused: a bunker watch (pid ${own}) is running for ${home}; use --when-idle to let it finish its current steps, update, and restart it`);
    return 2;
  }

  // Decided before any watch is drained: a refused update leaves every watch running as it is.
  const installed = opts.installed ?? (await currentBuild());
  const target = await resolveTarget(channel, home);
  if (typeof target === "number") return target;
  const commit = installed.commit ?? (await resolveCommit(home, installed.label.replace(/^main@/, "")));
  const dir = await direction(home, commit && (await resolveCommit(home, commit)), target.commit);
  const from = named(installed.version, installed.label);
  const to = named(target.version, target.label);
  if (dir === "same" && !opts.force) {
    console.log(`bunker: already at ${to} (${channel} channel); nothing to do`);
    return 0;
  }
  if (dir === "downgrade" || dir === "diverged") {
    // Name both commits, unless the label already does (main@<sha>).
    const at = (name: string, sha: string) => (name.includes(sha.slice(0, 7)) ? name : `${name} (${sha.slice(0, 7)})`);
    const [t, i] = [at(to, target.commit), at(from, commit!)];
    const what =
      dir === "downgrade"
        ? `${t} is behind the installed ${i}, so updating would be a downgrade`
        : `${t} has diverged from the installed ${i} (neither contains the other), so updating would drop commits`;
    if (!opts.force) {
      const other = channel === "release" ? "; `--channel main` tracks main instead" : "";
      console.error(`bunker: self-update refused on the ${channel} channel: ${what}. Nothing was rebuilt or restarted. Pass --force to install it anyway${other}`);
      return 2;
    }
    console.error(`bunker: self-update: warning: --force: downgrading the installed ${i} to ${t}`);
  }
  if (dir === "unknown") {
    console.error(`bunker: self-update: warning: can't tell whether ${to} is newer than the installed ${from} (its commit isn't in ${home}); updating anyway`);
  }

  if (opts.whenIdle) {
    const units = new Set(await watches.units());
    const repos = opts.restartAll ? [...new Set([home, ...units])] : [home];
    for (const repo of repos) {
      const pid = watchPid(repo);
      if (!pid) {
        // Nothing running there, but --restart-all still brings its active unit onto the new binary.
        if (units.has(repo) && opts.restartAll) stopped.push({ repo, unit: true });
        continue;
      }
      console.log(`bunker: self-update: asking the watch in ${repo} (pid ${pid}) to finish its current steps…`);
      if (!(await watches.stop(pid))) {
        console.error(`bunker: self-update: the watch in ${repo} did not stop; not updating`);
        await restartStopped(stopped, watches);
        return 1;
      }
      stopped.push({ repo, unit: units.has(repo) });
    }
  }
  try {
    const installedTo = await apply(channel, home, build, target, opts.target);
    if (typeof installedTo === "number") return installedTo;
    const verb = dir === "downgrade" || dir === "diverged" ? "downgraded" : dir === "same" ? "rebuilt" : "updated";
    console.log(`bunker: ${verb} ${from} → ${to}, installed to ${installedTo}`);
    return 0;
  } finally {
    await restartStopped(stopped, watches);
  }
}

interface Stopped {
  repo: string;
  /** Run by an active systemd unit, so it can be started again. */
  unit: boolean;
}

async function restartStopped(stopped: Stopped[], watches: WatchControl) {
  for (const { repo, unit } of stopped.splice(0)) {
    if (unit && (await watches.restartUnit(repo))) console.log(`bunker: self-update: restarted the watch unit for ${repo}`);
    else if (unit) console.error(`bunker: self-update: couldn't restart the watch unit for ${repo}`);
    else console.log(`bunker: self-update: the watch in ${repo} was not a systemd unit; restart it with \`bunker watch\``);
  }
}

/** Builds and installs `update`; the install path, or an exit code on failure. */
async function apply(channel: string, home: string, build: BuildFn, update: UpdateTarget, targetOpt: string | undefined): Promise<string | number> {
  const target = targetOpt ?? installTarget();
  if (channel === "main") {
    const pull = await safePull(home);
    if (!pull.pulled) {
      console.error(pull.message.replace("not pulling", "self-update can't pull"));
      return 2;
    }
    const bin = await build(home, home);
    if (!bin) return 1;
    install(bin, target);
    return target;
  }
  const tmp = mkdtempSync(join(tmpdir(), "bunker-release-"));
  const dir = join(tmp, "src");
  try {
    const wt = await $`git -C ${home} worktree add -q --detach ${dir} ${update.commit}`.nothrow().quiet();
    if (wt.exitCode !== 0) {
      console.error(`bunker: self-update: couldn't check out ${update.label}: ${wt.stderr.toString().trim()}`);
      return 1;
    }
    try {
      const bin = await build(dir, home);
      if (!bin) return 1;
      install(bin, target);
    } finally {
      await $`git -C ${home} worktree remove --force ${dir}`.nothrow().quiet();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return target;
}
