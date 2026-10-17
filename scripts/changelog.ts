import { $ } from "bun";
import { join } from "node:path";

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;
const parse = (t: string) => SEMVER.exec(t)?.slice(1).map(Number);
const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

/** The highest `vX.Y.Z` tag strictly below `version`, so re-running after tagging still diffs against the prior release. */
export function previousTag(tags: string[], version: string): string | undefined {
  const cur = parse(`v${version}`);
  if (!cur) return undefined;
  return tags
    .map((t) => t.trim())
    .flatMap((t) => {
      const n = parse(t);
      return n && cmp(n, cur) < 0 ? [{ t, n }] : [];
    })
    .sort((a, b) => cmp(a.n, b.n))
    .at(-1)?.t;
}

/** One `## vX.Y.Z` section listing the merged PR titles (commit subjects ending in `(#N)`). */
export function changelogSection(version: string, date: string, subjects: string[]): string {
  const prs = subjects.filter((s) => /\(#\d+\)\s*$/.test(s));
  const body = prs.length ? prs.map((s) => `- ${s}`).join("\n") : "No merged pull requests.";
  return `## v${version} - ${date}\n\n${body}\n`;
}

/** Puts `section` right under the `# Changelog` title (newest first); a version already present is left alone. */
export function prependSection(existing: string, section: string, version: string): string {
  if (existing.includes(`## v${version} `)) return existing;
  const rest = existing.replace(/^# Changelog\n+/, "");
  return `# Changelog\n\n${section}${rest ? `\n${rest}` : ""}`;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const arg = process.argv[2]?.replace(/^v/, "");
  const version = arg || (await Bun.file(join(root, "package.json")).json()).version;
  const tags = (await $`git -C ${root} tag --list ${"v*"}`.nothrow().quiet().text()).split("\n");
  const prev = previousTag(tags, version);
  const range = prev ? `${prev}..HEAD` : "HEAD";
  const log = await $`git -C ${root} log --first-parent --format=%s ${range}`.text();
  const section = changelogSection(version, new Date().toISOString().slice(0, 10), log.split("\n").filter(Boolean));
  const file = Bun.file(join(root, "CHANGELOG.md"));
  const current = (await file.exists()) ? await file.text() : "";
  await Bun.write(file, prependSection(current, section, version));
  console.log(`CHANGELOG.md: v${version} (${prev ? `since ${prev}` : "all history"})`);
}
