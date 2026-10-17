import { join } from "node:path";
import { gitLabel } from "../src/build-info.ts";

const root = join(import.meta.dir, "..");
const label = await gitLabel(root);
// A release build runs in a temp worktree; self-update points BUNKER_BUILD_HOME back at the real checkout.
const home = process.env.BUNKER_BUILD_HOME || root;
const r = Bun.spawnSync(
  ["bun", "build", "--compile", "src/cli.ts", "--outfile", "dist/bunker", "--define", `BUNKER_BUILD_LABEL=${JSON.stringify(label)}`, "--define", `BUNKER_BUILD_HOME=${JSON.stringify(home)}`],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exit(r.exitCode ?? 1);
