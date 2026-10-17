import type { RepoConfig } from "./config.ts";

type Flags = Record<string, string | boolean | string[] | undefined>;

/** A flag value that is not usable; the CLI prints the message and exits 2. */
export class FlagError extends Error {}

const positive = (raw: unknown) => {
  const n = Number(raw);
  return n > 0 && Number.isFinite(n) ? n : undefined;
};

/** --interval, --max-cost*, --audit-every, --triage-every over [watch] in config.toml. `fileCaps` are the user-level caps, which a flag also beats. */
export function resolveWatchSettings(values: Flags, watch: RepoConfig["watch"], fileCaps: { day?: number; month?: number }) {
  let intervalMin = watch.interval ?? 10;
  if (values.interval !== undefined) {
    const n = positive(values.interval);
    if (n === undefined) throw new FlagError("--interval must be a positive number of minutes");
    intervalMin = n;
  }
  const caps: { day?: number; month?: number } = { ...(watch.max_cost_day === undefined ? {} : { day: watch.max_cost_day }), ...(watch.max_cost_month === undefined ? {} : { month: watch.max_cost_month }), ...fileCaps };
  const day = values["max-cost-day"] ?? values["max-cost"];
  for (const [k, raw, flag] of [["day", day, values["max-cost-day"] === undefined ? "--max-cost" : "--max-cost-day"], ["month", values["max-cost-month"], "--max-cost-month"]] as const) {
    if (raw === undefined) continue;
    const n = positive(raw);
    if (n === undefined) throw new FlagError(`${flag} must be a positive number of US dollars`);
    caps[k] = n;
  }
  let auditEveryDays = watch.audit_every;
  if (values["audit-every"] !== undefined) {
    auditEveryDays = positive(values["audit-every"]);
    if (auditEveryDays === undefined) throw new FlagError("--audit-every must be a positive number of days");
  }
  let triageEveryHours = watch.triage_every;
  if (values["triage-every"] !== undefined) {
    triageEveryHours = positive(values["triage-every"]);
    if (triageEveryHours === undefined) throw new FlagError("--triage-every must be a positive number of hours");
  }
  return { intervalMin, caps, auditEveryDays, triageEveryHours };
}

/** --parallel over watch.parallel (config applies to --watch only). */
export function resolveParallel(values: Flags, watch: RepoConfig["watch"]): number {
  let parallel = values.watch ? watch.parallel ?? 1 : 1;
  if (values.parallel !== undefined) {
    parallel = Number(values.parallel);
    if (!Number.isInteger(parallel) || parallel < 1) throw new FlagError("--parallel must be a positive integer");
    if (!values.queue) throw new FlagError("--parallel only applies to --queue and --watch");
    if (parallel > 1 && !values.merge) throw new FlagError("--parallel above 1 needs --merge (--watch always merges)");
  }
  return parallel;
}

/** --ci-timeout over merge.ci_timeout (config applies only when merging). */
export function resolveCiTimeout(values: Flags, merge: RepoConfig["merge"]): number | undefined {
  if (values["ci-timeout"] === undefined) return values.merge ? merge.ci_timeout : undefined;
  const n = Number(values["ci-timeout"]);
  if (!(n > 0) || !values.merge) throw new FlagError("--ci-timeout must be a positive number of minutes and requires --merge");
  return n;
}

/** --idle-timeout (minutes), --completion-timeout (seconds) and --step-timeout (minutes) as milliseconds. */
export function resolveTimeouts(values: Flags): { idleTimeoutMs?: number; completionTimeoutMs?: number; stepTimeoutMs?: number } {
  const timeouts: { idleTimeoutMs?: number; completionTimeoutMs?: number; stepTimeoutMs?: number } = {};
  for (const [flag, key, unit, ms] of [
    ["idle-timeout", "idleTimeoutMs", "minutes", 60_000],
    ["completion-timeout", "completionTimeoutMs", "seconds", 1000],
    ["step-timeout", "stepTimeoutMs", "minutes", 60_000],
  ] as const) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!(n > 0)) throw new FlagError(`--${flag} must be a positive number of ${unit}`);
    timeouts[key] = n * ms;
  }
  return timeouts;
}
