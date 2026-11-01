/** The signal of the process-wide stop (set by `bunker watch`), so a step deep in a run can tell a stop is under way. */
export const shutdown: { signal?: AbortSignal } = {};
