import { $ } from "bun";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildCommit, bunkerHome } from "./build-info.ts";
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

/** Pulls, rebuilds and reinstalls bunker. Returns the exit code; messages go to the console. */
export async function selfUpdate(): Promise<number> {
  const home = bunkerHome();
  if (!existsSync(join(home, ".git"))) {
    console.error(`bunker: self-update: ${home} is not a git checkout (set BUNKER_HOME to your tool-bunker checkout)`);
    return 2;
  }
  const blocker = await pullBlocker(home);
  if (blocker) {
    console.error(`bunker: self-update refused in ${home}: ${blocker}`);
    return 2;
  }
  try {
    const pid = Number(readFileSync(join(home, ".bunker", "watch.lock"), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      console.error(`bunker: self-update refused: a bunker --watch (pid ${pid}) is running for ${home}`);
      return 2;
    }
  } catch {}

  const oldVersion = version(home);
  const oldCommit = await buildCommit();
  const pull = await safePull(home);
  if (!pull.pulled) {
    console.error(pull.message.replace("not pulling", "self-update can't pull"));
    return 2;
  }
  for (const cmd of [["bun", "install", "--frozen-lockfile"], ["bun", "run", "build"]]) {
    const r = Bun.spawnSync(cmd, { cwd: home, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) {
      console.error(`bunker: self-update: \`${cmd.join(" ")}\` failed`);
      return 1;
    }
  }
  const target = installTarget();
  mkdirSync(dirname(target), { recursive: true });
  // Rename over the target: a running binary can't be written to, but it can be replaced.
  const tmp = `${target}.new-${process.pid}`;
  copyFileSync(join(home, "dist", "bunker"), tmp);
  renameSync(tmp, target);
  console.log(`bunker: updated ${oldVersion} (${oldCommit}) → ${version(home)} (${await commitOf(home)}), installed to ${target}`);
  return 0;
}
