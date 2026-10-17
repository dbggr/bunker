import { $ } from "bun";
import { dirname, join } from "node:path";

// Replaced by `bun run build` (scripts/build.ts) via --define; absent when running from source.
declare const BUNKER_BUILD_LABEL: string | undefined;
declare const BUNKER_BUILD_HOME: string | undefined;

/** The tool-bunker checkout: BUNKER_HOME, else the repo the binary was built from. */
export const bunkerHome = (): string =>
  process.env.BUNKER_HOME || (typeof BUNKER_BUILD_HOME === "string" ? BUNKER_BUILD_HOME : join(dirname(import.meta.dir), "")) ;


/** `vX.Y.Z` when `root` is checked out at a release tag, else `main@<sha>`. */
export async function gitLabel(root: string): Promise<string> {
  const tag = (await $`git -C ${root} describe --tags --exact-match --match ${"v[0-9]*"} HEAD`.nothrow().quiet().text()).trim();
  if (tag) return tag;
  const sha = (await $`git -C ${root} rev-parse --short HEAD`.nothrow().quiet().text()).trim();
  return sha ? `main@${sha}` : "unknown";
}

/** The release tag or `main@<sha>` this build came from; asks git when run from source. */
export async function buildLabel(): Promise<string> {
  if (typeof BUNKER_BUILD_LABEL === "string" && BUNKER_BUILD_LABEL) return BUNKER_BUILD_LABEL;
  return gitLabel(join(import.meta.dir, ".."));
}
