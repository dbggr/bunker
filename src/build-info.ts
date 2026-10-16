import { $ } from "bun";
import { dirname, join } from "node:path";

// Replaced by `bun run build` (scripts/build.ts) via --define; absent when running from source.
declare const BUNKER_BUILD_COMMIT: string | undefined;
declare const BUNKER_BUILD_HOME: string | undefined;

/** The tool-bunker checkout: BUNKER_HOME, else the repo the binary was built from. */
export const bunkerHome = (): string =>
  process.env.BUNKER_HOME || (typeof BUNKER_BUILD_HOME === "string" ? BUNKER_BUILD_HOME : join(dirname(import.meta.dir), "")) ;

/** The commit this build came from; falls back to asking git when run from source. */
export async function buildCommit(): Promise<string> {
  if (typeof BUNKER_BUILD_COMMIT === "string" && BUNKER_BUILD_COMMIT) return BUNKER_BUILD_COMMIT;
  const r = await $`git -C ${join(import.meta.dir, "..")} rev-parse --short HEAD`.nothrow().quiet();
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}
