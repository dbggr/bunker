import { join } from "node:path";
import { gitCommit, gitLabel } from "../src/build-info.ts";

const root = join(import.meta.dir, "..");
const label = await gitLabel(root);
// Recorded so self-update can tell whether a target is behind this build.
const commit = (await gitCommit(root)) ?? "";
// A release build runs in a temp worktree; self-update points BUNKER_BUILD_HOME back at the real checkout.
const home = process.env.BUNKER_BUILD_HOME || root;
const defines = { BUNKER_BUILD_LABEL: label, BUNKER_BUILD_HOME: home, BUNKER_BUILD_COMMIT: commit };
const r = Bun.spawnSync(
  ["bun", "build", "--compile", "src/cli.ts", "--outfile", "dist/bunker", ...Object.entries(defines).flatMap(([k, v]) => ["--define", `${k}=${JSON.stringify(v)}`])],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exit(r.exitCode ?? 1);
