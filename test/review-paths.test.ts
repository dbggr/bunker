import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { DEFAULT_REVIEW_PATHS, isReviewPath } from "../src/worktree/steering.ts";

setDefaultTimeout(60_000); // see test/setup.ts

describe("isReviewPath", () => {
  test("covers the defaults at any depth, and the sensitive dirs", () => {
    for (const f of ["package.json", "sub/bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.json", "composer.lock", "Makefile", ".github/x.yml", ".bunker/config.toml", "CLAUDE.md"]) expect(isReviewPath(f, [])).toBe(true);
    expect(DEFAULT_REVIEW_PATHS).toContain("Makefile");
    expect(isReviewPath("src/index.ts", [])).toBe(false);
  });
  test("extra globs", () => {
    expect(isReviewPath("src/pipeline/steps/pr.ts", ["src/pipeline/steps/pr.ts"])).toBe(true);
    expect(isReviewPath("src/gate/a/b.ts", ["src/gate/**"])).toBe(true);
    expect(isReviewPath("src/other.ts", ["src/gate/**"])).toBe(false);
  });
});
