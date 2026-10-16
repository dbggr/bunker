import { $ } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const commit = (await $`git -C ${root} rev-parse --short HEAD`.nothrow().quiet().text()).trim() || "unknown";
const r = Bun.spawnSync(
  ["bun", "build", "--compile", "src/cli.ts", "--outfile", "dist/bunker", "--define", `BUNKER_BUILD_COMMIT=${JSON.stringify(commit)}`, "--define", `BUNKER_BUILD_HOME=${JSON.stringify(root)}`],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exit(r.exitCode ?? 1);
