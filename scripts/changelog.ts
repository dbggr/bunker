import { $ } from "bun";
import { join } from "node:path";
import { latestTag } from "../src/self-update.ts";

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
  const prev = await latestTag(root);
  const range = prev && prev !== `v${version}` ? `${prev}..HEAD` : "HEAD";
  const log = await $`git -C ${root} log --first-parent --format=%s ${range}`.text();
  const section = changelogSection(version, new Date().toISOString().slice(0, 10), log.split("\n").filter(Boolean));
  const file = Bun.file(join(root, "CHANGELOG.md"));
  const current = (await file.exists()) ? await file.text() : "";
  await Bun.write(file, prependSection(current, section, version));
  console.log(`CHANGELOG.md: v${version} (${prev ? `since ${prev}` : "all history"})`);
}
