
/** Stages in which a run only waits on GitHub: there is no agent of it to stop. */
const WAITING = new Set(["waiting for merge", "awaiting review"]);

/** The issues of `current` that have an active run (container, worktree) in this watch. */
export const activeIssues = (current: { issue: number; stage: string }[]): number[] => current.filter((c) => !WAITING.has(c.stage)).map((c) => c.issue);

export interface CancelDeps {
  active: () => number[];
  /** Marks the run cancelled, so it starts nothing new and its result is not a failure. */
  mark: (issue: number) => void;
  /** Writes the cancel into the run's log. */
  record: (issue: number) => void;
  /** Kills the run's containers. */
  stopContainers: (issue: number) => void;
  /** Keeps the run's worktree work as a stale tag; returns the tag. */
  abandon: (issue: number) => Promise<string | undefined>;
  /** Removes `bunker:in-progress` and `bunker:queued`. */
  unlabel: (issue: number) => Promise<void>;
  comment: (issue: number, body: string) => Promise<void>;
  log: (line: string) => void;
}

/** Cancels one issue's run and leaves the others alone. Returns false when the issue has no active run. */
export function createCanceller(d: CancelDeps) {
  return async (issue: number): Promise<boolean> => {
    if (!d.active().includes(issue)) {
      d.log(`bunker: cancel #${issue}: no active run, ignored`);
      return false;
    }
    d.mark(issue);
    d.record(issue);
    d.stopContainers(issue);
    const kept = await d.abandon(issue).catch(() => undefined);
    await d.unlabel(issue);
    await d.comment(issue, `bunker: this run was cancelled on request.${kept ? ` Its work is kept as the tag \`${kept}\`.` : ""} Relabel \`bunker:queued\` to run it again.`);
    d.log(`bunker: #${issue} cancelled${kept ? `; work kept as tag ${kept}` : ""}`);
    return true;
  };
}
