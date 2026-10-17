import { $ } from "bun";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildLabel, bunkerHome } from "./build-info.ts";
import { pullBlocker, safePull } from "./pull.ts";
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

/** Builds the tree in `dir` (for the tool-bunker checkout `home`) and returns the path of the compiled binary. */
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
    console.error(`bunker: self-update: ${home} is not a git checkout (set BUNKER_HOME to your tool-bunker checkout)`);
    return 2;
  }
  if (channel === "main") {
    const blocker = await pullBlocker(home);
    if (blocker) {
      console.error(`bunker: self-update refused in ${home}: ${blocker}`);
      return 2;
    }
  }
  try {
    const pid = Number(readFileSync(join(home, ".bunker", "watch.lock"), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      console.error(`bunker: self-update refused: a bunker --watch (pid ${pid}) is running for ${home}`);
      return 2;
    }
  } catch {}

  const oldVersion = version(home);
  const oldLabel = await buildLabel();
  const target = opts.target ?? installTarget();
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
