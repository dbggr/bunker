/** Queue order: `priority:high` → `priority:medium` → none → `priority:low`; then `bug` first; then oldest first. */
export const PRIORITY_LABELS = [
  { name: "priority:high", color: "B60205", rank: 0, short: "high" },
  { name: "priority:medium", color: "D93F0B", rank: 1, short: "medium" },
  { name: "priority:low", color: "BFBFBF", rank: 3, short: "low" },
] as const;

const NO_PRIORITY_RANK = 2;

export interface Queued {
  number: number;
  title: string;
  createdAt: string;
  labels?: { name: string }[];
}

export function priorityRank(labels: { name: string }[] = []): number {
  const ranks = PRIORITY_LABELS.filter((p) => labels.some((l) => l.name === p.name)).map((p) => p.rank);
  return ranks.length ? Math.min(...ranks) : NO_PRIORITY_RANK;
}

export const isBug = (labels: { name: string }[] = []) => labels.some((l) => l.name === "bug");

/** Candidates in the order they should run. */
export function orderQueue<T extends Queued>(issues: T[]): T[] {
  return [...issues].sort(
    (a, b) =>
      priorityRank(a.labels) - priorityRank(b.labels) ||
      Number(isBug(b.labels)) - Number(isBug(a.labels)) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.number - b.number,
  );
}

/** `#160 (high, bug)`, `#131`, `#132 (low)`: why an issue sits where it does. */
export function describeQueued(q: Queued): string {
  const rank = priorityRank(q.labels);
  const why = [PRIORITY_LABELS.find((p) => p.rank === rank)?.short, isBug(q.labels) ? "bug" : undefined].filter(Boolean);
  return `#${q.number}${why.length ? ` (${why.join(", ")})` : ""}`;
}

export const describeQueue = (issues: Queued[]) => `queue: ${issues.map(describeQueued).join(" · ")}`;
