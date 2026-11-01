import { $ } from "bun";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildLabel, bunkerHome } from "../../build-info.ts";
import { pullBlocker, safePull } from "../../github/pull.ts";
import { escapePath, unescapePath } from "../../mcp/server.ts";
import { alive } from "./watch.ts";

const version = (home: string) => {
  try {
    return JSON.parse(readFileSync(join(home, "package.json"), "utf8")).version as string;
  } catch {
    return "unknown";
  }
};
const commitOf = async (home: string) => (await $`git -C ${home} rev-parse --short HEAD`.nothrow().quiet().text()).trim() || "unknown";

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
    return await apply(channel, home, build, opts.target);
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

async function apply(channel: string, home: string, build: BuildFn, targetOpt: string | undefined): Promise<number> {
  const oldVersion = version(home);
  const oldLabel = await buildLabel();
  const target = targetOpt ?? installTarget();
  let newLabel: string;

  if (channel === "main") {
    const pull = await safePull(home);
    if (!pull.pulled) {
      console.error(pull.message.replace("not pulling", "self-update can't pull"));
      return 2;
    }
    const bin = await build(home, home);
    if (!bin) return 1;
    install(bin, target);
    newLabel = `main@${await commitOf(home)}`;
  } else {
    const fetched = await $`git -C ${home} fetch --tags --force -q origin`.nothrow().quiet();
    if (fetched.exitCode !== 0) console.error("bunker: self-update: couldn't fetch tags from origin; using local tags");
    const tag = await latestTag(home);
    if (!tag) {
      console.error("bunker: self-update: no v* release tags found (use --channel main to track main)");
      return 2;
    }
    const tmp = mkdtempSync(join(tmpdir(), "bunker-release-"));
    const dir = join(tmp, "src");
    try {
      const wt = await $`git -C ${home} worktree add -q --detach ${dir} ${`refs/tags/${tag}`}`.nothrow().quiet();
      if (wt.exitCode !== 0) {
        console.error(`bunker: self-update: couldn't check out ${tag}: ${wt.stderr.toString().trim()}`);
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
    newLabel = tag;
  }
  console.log(`bunker: updated ${oldVersion} (${oldLabel}) → ${newLabel}, installed to ${target}`);
  return 0;
}
