import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The issue a run belongs to, for everything running inside it (agent steps, containers). */
export const issueScope = new AsyncLocalStorage<number>();

const cancelled = new Set<number>();

/** Marks the run of `issue` as cancelled: its steps start no new agent session. */
export const markCancelled = (issue: number) => void cancelled.add(issue);
/** True once, if `issue` was marked cancelled; forgets the mark. */
export const takeCancelled = (issue: number) => cancelled.delete(issue);
/** Whether the run this code is part of was cancelled. */
export const cancelRequested = () => {
  const n = issueScope.getStore();
  return n !== undefined && cancelled.has(n);
};

/** Notes in the issue's latest run log that a human cancelled it, so interventions can be counted from the logs. */
export function recordCancel(repo: string, issue: number): void {
  const dir = join(repo, ".bunker", "runs");
  try {
    const latest = readdirSync(dir).filter((f) => f.startsWith(`${issue}-`) && f.endsWith(".log")).sort().at(-1);
    if (latest) appendFileSync(join(dir, latest), "== cancelled by request ==\n\n");
  } catch {}
}

/** Running containers (name) by the issue that started them. */
export const containerIssues = new Map<string, number>();

/** Where `bunker cancel` and the MCP leave requests for the watch of `repo`: one empty file per issue. */
const requestDir = (repo: string) => join(repo, ".bunker", "cancel");

export function requestCancel(repo: string, issue: number): void {
  mkdirSync(requestDir(repo), { recursive: true });
  writeFileSync(join(requestDir(repo), String(issue)), "");
}

/** The pending cancel requests of `repo`, removed as they are read. */
export function takeCancelRequests(repo: string): number[] {
  let names: string[];
  try {
    names = readdirSync(requestDir(repo));
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    rmSync(join(requestDir(repo), f), { force: true });
    return /^\d+$/.test(f) ? [Number(f)] : [];
  });
}
