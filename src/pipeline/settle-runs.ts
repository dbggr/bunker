import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { emit, type OnEvent } from "../core/events.ts";

const FINAL = /^== final status: /m;
/** Run logs older than this are settled on disk but no longer announced to the hub (it forgets that old a history). */
const ANNOUNCE_MS = 7 * 86_400_000;

/**
 * Closes the runs a dead watcher left open: the newest `.bunker/runs/<n>-*.log` of each issue with no
 * `final status` line gets one (`interrupted`), and the hub gets the matching closing stage event.
 * Call it only while holding `watch.lock`, so no run of ours can still be writing.
 * Returns the issue numbers settled.
 */
export function settleOrphanedRuns(repo: string, onEvent?: OnEvent): number[] {
  const dir = join(repo, ".bunker", "runs");
  if (!existsSync(dir)) return [];
  const newest = new Map<number, string>();
  for (const f of readdirSync(dir).sort()) {
    const m = /^(\d+)-.+\.log$/.exec(f);
    if (m) newest.set(Number(m[1]), f);
  }
  const settled: number[] = [];
  for (const [issue, f] of newest) {
    const file = join(dir, f);
    try {
      if (FINAL.test(readFileSync(file, "utf8"))) continue;
      const age = Date.now() - statSync(file).mtimeMs;
      appendFileSync(file, "== final status: interrupted ==\nthe watcher stopped before this run finished\n\n");
      settled.push(issue);
      if (age < ANNOUNCE_MS) emit(onEvent, { type: "stage", name: "interrupted", issue, text: "the watcher stopped before this run finished" });
    } catch {}
  }
  return settled;
}
