import { $ } from "bun";

export type MissingHunk = { file: string; header: string; lines: string[] };

/**
 * Checks that the lines a PR added (the diff `base` → `head`) are all in `target`'s version of the same file, so a change
 * main made to the same file in the meantime is not mistaken for a dropped one. Returns the hunks with lines missing.
 */
export async function missingHunks(repo: string, base: string, head: string, target: string): Promise<MissingHunk[] | { error: string }> {
  const diff = await $`git -C ${repo} -c core.quotepath=false diff -U0 --no-color --no-renames ${base} ${head}`.nothrow().quiet();
  if (diff.exitCode !== 0) return { error: diff.stderr.toString().trim() };
  const out: MissingHunk[] = [];
  const present = new Map<string, Set<string>>();
  const linesOf = async (file: string) => {
    let s = present.get(file);
    if (!s) {
      const r = await $`git -C ${repo} show ${`${target}:${file}`}`.nothrow().quiet();
      s = new Set(r.exitCode === 0 ? r.stdout.toString().split("\n").map((l) => l.trimEnd()) : []);
      present.set(file, s);
    }
    return s;
  };
  let file = "";
  let cur: { header: string; added: string[] } | undefined;
  const flush = async () => {
    if (!cur || !file) return;
    const have = await linesOf(file);
    const lines = cur.added.filter((l) => l.trim() !== "" && !have.has(l));
    if (lines.length) out.push({ file, header: cur.header, lines });
    cur = undefined;
  };
  for (const line of diff.stdout.toString().split("\n")) {
    if (line.startsWith("diff --git ")) {
      await flush();
      file = "";
    } else if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : "";
    else if (line.startsWith("@@")) {
      await flush();
      cur = { header: line.replace(/^(@@ [^@]*@@).*$/, "$1"), added: [] };
    } else if (cur && line.startsWith("+")) cur.added.push(line.slice(1).trimEnd());
  }
  await flush();
  return out;
}

export function describeMissing(target: string, hunks: MissingHunk[]): string {
  const shown = hunks.slice(0, 10).map((h) => `${h.file} ${h.header}\n${h.lines.slice(0, 5).map((l) => `  + ${l}`).join("\n")}${h.lines.length > 5 ? "\n  + …" : ""}`);
  return `merged, but part of the PR's own change is missing from ${target}:\n${shown.join("\n")}${hunks.length > 10 ? "\n…" : ""}`;
}
