import { $ } from "bun";

type Env = Record<string, string>;

/** The `bunker:` label namespace. Labels only display state; decisions come from GitHub events, `watch.lock`/worktrees and PR state. */
export const QUEUED_LABEL = "bunker:queued";
export const IN_PROGRESS_LABEL = "bunker:in-progress";
export const FAILED_LABEL = "bunker:failed";
export const REVIEW_LABEL = "bunker:review";
export const AWAITING_REVIEW_LABEL = "bunker:awaiting-review";
export const BLOCKED_LABEL = "bunker-blocked";
export const EXCLUDE_LABEL = "bunker:exclude";

/** Only `bunker:queued` queues an issue (never `in-progress`, `failed` or `review`). */
export const isQueuedLabel = (name: string) => name === QUEUED_LABEL;
export const hasQueuedLabel = (labels: { name: string }[]) => labels.some((l) => isQueuedLabel(l.name));
/** `bunker:exclude` marks an issue as never for bunker: it is not triaged, queued or worked, even if also `bunker:queued`. */
export const hasExcludeLabel = (labels: { name: string }[] | undefined) => !!labels?.some((l) => l.name === EXCLUDE_LABEL);

/** jq condition matching `labeled` events of the queueing label. */
export const QUEUED_EVENT_JQ = `.event == "labeled" and .label.name == "${QUEUED_LABEL}"`;

const COLORS: Record<string, [string, string]> = {
  [QUEUED_LABEL]: ["0E8A16", "queued for bunker; only a maintainer's label starts work"],
  [IN_PROGRESS_LABEL]: ["1D76DB", "a bunker run is working on this issue"],
  [FAILED_LABEL]: ["B60205", "bunker gave up on this issue; relabel `bunker:queued` to retry"],
  [REVIEW_LABEL]: ["D93F0B", "bunker will not auto-merge this PR; it waits for a human"],
  [AWAITING_REVIEW_LABEL]: ["FBCA04", "manual-merge mode: bunker keeps this PR green and never merges it"],
  [EXCLUDE_LABEL]: ["000000", "never for bunker: not triaged, queued or worked, even if also bunker:queued"],
};

/** `--color`/`--description` args for `gh label create` of a bunker label (none for other names). */
export function labelCreateArgs(name: string): string[] {
  const c = COLORS[name];
  return c ? ["--color", c[0], "--description", c[1]] : [];
}

export async function ensureLabel(name: string, cwd: string, env: Env) {
  await $`gh label create ${name} ${labelCreateArgs(name)}`.cwd(cwd).env(env).nothrow().quiet();
}

/** Run start: shows `bunker:in-progress` and clears a previous `bunker:failed`. Best effort. */
export async function markInProgress(issue: number, cwd: string, env: Env): Promise<void> {
  await ensureLabel(IN_PROGRESS_LABEL, cwd, env);
  await $`gh issue edit ${issue} --add-label ${IN_PROGRESS_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
  const labels = await issueLabels(issue, cwd, env);
  if (labels?.includes(FAILED_LABEL)) await $`gh issue edit ${issue} --remove-label ${FAILED_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
}

/** Run end: removes `bunker:in-progress`. Best effort. */
export async function clearInProgress(issue: number, cwd: string, env: Env): Promise<void> {
  await $`gh issue edit ${issue} --remove-label ${IN_PROGRESS_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
}

/** Label names on the issue; undefined if gh can't say. */
export async function issueLabels(issue: number, cwd: string, env: Env): Promise<string[] | undefined> {
  const r = await $`gh issue view ${issue} --json labels`.cwd(cwd).env(env).nothrow().quiet();
  if (r.exitCode !== 0) return undefined;
  try {
    const labels = (JSON.parse(r.stdout.toString()) as { labels?: { name?: unknown }[] }).labels;
    return Array.isArray(labels) ? labels.flatMap((l) => (typeof l?.name === "string" ? [l.name] : [])) : undefined;
  } catch {
    return undefined;
  }
}

/** Removes `bunker:queued` from the issue (if it has it), plus `extra` flags (e.g. `--add-label`). */
export async function unqueue(issue: number, cwd: string, env: Env, extra: string[] = []) {
  const labels = await issueLabels(issue, cwd, env);
  const remove = labels === undefined || labels.includes(QUEUED_LABEL) ? ["--remove-label", QUEUED_LABEL] : [];
  return $`gh issue edit ${issue} ${remove} ${extra}`.cwd(cwd).env(env).nothrow().quiet();
}

/** PR number from a PR URL or a plain number. */
const prNumber = (pr: number | string) => (typeof pr === "number" ? pr : (/\/pull\/(\d+)/.exec(pr)?.[1] ?? String(pr)));

type Outcome = { ok: boolean; error: string };
const outcome = (r: { exitCode: number; stderr: Buffer }): Outcome => ({ ok: r.exitCode === 0, error: r.stderr.toString().trim() });

/** Labels a PR through REST: the pr-edit subcommand queries Projects (classic), which GitHub is retiring, and fails. */
export async function addPrLabel(pr: number | string, name: string, cwd: string, env: Env): Promise<Outcome> {
  return outcome(await $`gh api -X POST repos/{owner}/{repo}/issues/${prNumber(pr)}/labels -f ${`labels[]=${name}`}`.cwd(cwd).env(env).nothrow().quiet());
}

export async function removePrLabel(pr: number | string, name: string, cwd: string, env: Env): Promise<Outcome> {
  return outcome(await $`gh api -X DELETE repos/{owner}/{repo}/issues/${prNumber(pr)}/labels/${encodeURIComponent(name)}`.cwd(cwd).env(env).nothrow().quiet());
}

export async function requestReviewer(pr: number | string, login: string, cwd: string, env: Env): Promise<Outcome> {
  return outcome(await $`gh api -X POST repos/{owner}/{repo}/pulls/${prNumber(pr)}/requested_reviewers -f ${`reviewers[]=${login}`}`.cwd(cwd).env(env).nothrow().quiet());
}

/** A run that ended with its PR waiting for a human: swaps `bunker:queued` and `bunker:in-progress` for `bunker:awaiting-review`, so the issue no longer looks queued. Best effort. */
export async function markAwaitingReview(issue: number, cwd: string, env: Env): Promise<void> {
  await ensureLabel(AWAITING_REVIEW_LABEL, cwd, env);
  await unqueue(issue, cwd, env, ["--add-label", AWAITING_REVIEW_LABEL, "--remove-label", IN_PROGRESS_LABEL]);
}

/** Drops `bunker:awaiting-review` from the issue. Best effort. */
export async function clearAwaitingReview(issue: number, cwd: string, env: Env): Promise<void> {
  await $`gh issue edit ${issue} --remove-label ${AWAITING_REVIEW_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
}

/** An issue whose PR landed: drops `bunker:queued`, `bunker:in-progress` and `bunker:awaiting-review`, which the closed issue would otherwise keep. Best effort. */
export async function clearLanded(issue: number, cwd: string, env: Env): Promise<void> {
  await unqueue(issue, cwd, env);
  await clearInProgress(issue, cwd, env);
  await clearAwaitingReview(issue, cwd, env);
}

/** Issue numbers carrying `label` in `state`; empty when gh fails. */
async function issuesWith(label: string, state: "open" | "closed", cwd: string, env: Env): Promise<number[]> {
  const list = await $`gh issue list --label ${label} --state ${state} --limit 100 --json number`.cwd(cwd).env(env).nothrow().quiet();
  if (list.exitCode !== 0) return [];
  try {
    return (JSON.parse(list.stdout.toString() || "[]") as { number?: unknown }[]).flatMap((i) => (typeof i?.number === "number" ? [i.number] : []));
  } catch {
    return [];
  }
}

/** Closed issues still labelled `bunker:awaiting-review` (their PR merged): the label is removed. Returns the issues cleared. */
export async function sweepClosedAwaitingReview(cwd: string, env: Env): Promise<number[]> {
  const cleared: number[] = [];
  for (const n of await issuesWith(AWAITING_REVIEW_LABEL, "closed", cwd, env)) {
    const r = await $`gh issue edit ${n} --remove-label ${AWAITING_REVIEW_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
    if (r.exitCode === 0) cleared.push(n);
  }
  return cleared;
}

/**
 * Open issues labelled `bunker:awaiting-review` whose PR closed unmerged (`closedUnmerged`): the label is removed and the issue is not
 * re-queued; a maintainer relabels `bunker:queued` to retry. Returns the issues released.
 */
export async function releaseUnmergedReview(closedUnmerged: Set<number>, cwd: string, env: Env): Promise<number[]> {
  if (!closedUnmerged.size) return [];
  const released: number[] = [];
  for (const n of await issuesWith(AWAITING_REVIEW_LABEL, "open", cwd, env)) {
    if (!closedUnmerged.has(n)) continue;
    const r = await $`gh issue edit ${n} --remove-label ${AWAITING_REVIEW_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
    if (r.exitCode === 0) released.push(n);
  }
  return released;
}

/**
 * Closed issues that still carry `bunker:queued` (their PR auto-merged while no watcher was looking, e.g. across a restart) get it,
 * and `bunker:in-progress`, removed in one `gh issue edit` each. Stateless, so it catches what the shepherd's in-memory view of open PRs
 * misses. Handles at most 100 issues per call (a bigger backlog drains over repeated sweeps). Returns the issues cleared.
 */
export async function sweepClosedQueued(cwd: string, env: Env): Promise<number[]> {
  const list = await $`gh issue list --label ${QUEUED_LABEL} --state closed --limit 100 --json number`.cwd(cwd).env(env).nothrow().quiet();
  if (list.exitCode !== 0) return [];
  let numbers: number[];
  try {
    numbers = (JSON.parse(list.stdout.toString() || "[]") as { number?: unknown }[]).flatMap((i) => (typeof i?.number === "number" ? [i.number] : []));
  } catch {
    return [];
  }
  const cleared: number[] = [];
  for (const n of numbers) {
    const r = await $`gh issue edit ${n} --remove-label ${QUEUED_LABEL} --remove-label ${IN_PROGRESS_LABEL}`.cwd(cwd).env(env).nothrow().quiet();
    if (r.exitCode === 0) cleared.push(n);
  }
  return cleared;
}
