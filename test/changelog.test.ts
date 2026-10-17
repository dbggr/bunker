import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { changelogSection, prependSection } from "../scripts/changelog.ts";

setDefaultTimeout(60_000); // see test/setup.ts

describe("changelog", () => {
  test("section lists merged PR titles, skipping commits without a PR number", () => {
    const s = changelogSection("1.0.0", "2026-10-17", ["feat: a thing (#12)", "wip local commit", "fix: b (#13)"]);
    expect(s).toBe("## v1.0.0 - 2026-10-17\n\n- feat: a thing (#12)\n- fix: b (#13)\n");
  });

  test("empty release says so", () => {
    expect(changelogSection("1.0.1", "2026-10-18", [])).toContain("No merged pull requests.");
  });

  test("prepends under the title, newest first, and is idempotent per version", () => {
    const a = prependSection("", changelogSection("1.0.0", "d", ["x (#1)"]), "1.0.0");
    expect(a.startsWith("# Changelog\n\n## v1.0.0")).toBe(true);
    const b = prependSection(a, changelogSection("1.1.0", "d", ["y (#2)"]), "1.1.0");
    expect(b.indexOf("## v1.1.0")).toBeLessThan(b.indexOf("## v1.0.0"));
    expect(prependSection(b, changelogSection("1.1.0", "d", ["z (#3)"]), "1.1.0")).toBe(b);
  });
});
