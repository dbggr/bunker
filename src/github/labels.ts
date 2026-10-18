import { $ } from "bun";

type Env = Record<string, string>;

/** The `bunker:` label namespace. Labels only display state; decisions come from GitHub events, `watch.lock`/worktrees and PR state. */
export const QUEUED_LABEL = "bunker:queued";
export const IN_PROGRESS_LABEL = "bunker:in-progress";
export const FAILED_LABEL = "bunker:failed";
export const REVIEW_LABEL = "bunker:review";
export const AWAITING_REVIEW_LABEL = "bunker:awaiting-review";

/** Pre-namespace names, still accepted for one release (`bunker` counts as `bunker:queued`, gated the same way). */
export const LEGACY_QUEUED_LABEL = "bunker";
export const LEGACY_FAILED_LABEL = "bunker-failed";
export const LEGACY_REVIEW_LABEL = "needs-human-review";

/** Labels that queue an issue (never `in-progress`, `failed` or `review`). */
export const QUEUED_LABELS = [QUEUED_LABEL, LEGACY_QUEUED_LABEL] as const;

export const isQueuedLabel = (name: string) => (QUEUED_LABELS as readonly string[]).includes(name);
export const hasQueuedLabel = (labels: { name: string }[]) => labels.some((l) => isQueuedLabel(l.name));

/** jq condition matching `labeled` events of a queueing label. */
export const QUEUED_EVENT_JQ = `.event == "labeled" and (.label.name == "${QUEUED_LABEL}" or .label.name == "${LEGACY_QUEUED_LABEL}")`;

const COLORS: Record<string, [string, string]> = {
  [QUEUED_LABEL]: ["0E8A16", "queued for bunker; only a maintainer's label starts work"],
  [IN_PROGRESS_LABEL]: ["1D76DB", "a bunker run is working on this issue"],
  [FAILED_LABEL]: ["B60205", "bunker gave up on this issue; relabel `bunker:queued` to retry"],
  [REVIEW_LABEL]: ["D93F0B", "bunker will not auto-merge this PR; it waits for a human"],
  [AWAITING_REVIEW_LABEL]: ["FBCA04", "manual-merge mode: bunker keeps this PR green and never merges it"],
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
  const stale = [FAILED_LABEL, LEGACY_FAILED_LABEL].filter((l) => labels?.includes(l));
  if (stale.length) await $`gh issue edit ${issue} ${stale.flatMap((l) => ["--remove-label", l])}`.cwd(cwd).env(env).nothrow().quiet();
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

/** The queueing labels (`bunker:queued` and/or legacy `bunker`) the issue currently has; a removal of one it lacks would fail. */
export async function queuedLabelsOn(issue: number, cwd: string, env: Env): Promise<string[]> {
  const labels = await issueLabels(issue, cwd, env);
  return labels === undefined ? [QUEUED_LABEL] : QUEUED_LABELS.filter((l) => labels.includes(l));
}

/** Removes the queueing label(s) from the issue, plus `extra` flags (e.g. `--add-label`). */
export async function unqueue(issue: number, cwd: string, env: Env, extra: string[] = []) {
  const remove = (await queuedLabelsOn(issue, cwd, env)).flatMap((l) => ["--remove-label", l]);
  return $`gh issue edit ${issue} ${remove} ${extra}`.cwd(cwd).env(env).nothrow().quiet();
}
