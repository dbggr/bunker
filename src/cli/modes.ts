import { FlagError } from "../core/settings.ts";
import type { CliValues } from "./args.ts";

/** The run modes, each a subcommand: `bunker watch`, `bunker issue 7`, … */
export const MODES = ["issue", "queue", "watch", "audit", "review", "task"] as const;
export type Mode = (typeof MODES)[number];

/** The mode flags of 0.x. They still parse, only so that using one can say what replaced it. */
const REMOVED = { "--issue": "issue <n>", "--queue": "queue", "--watch": "watch", "--audit": "audit", "--review": "review", "--task": "task" } as const;

const COMMON = ["help", "version", "verbose", "model", "implementer-model", "no-sandbox", "image", "idle-timeout", "completion-timeout", "step-timeout"];
const ROUNDS = ["max-rounds", "reviewer-model", "no-resume"];
const LIVE = ["ui", "port", "ui-keep", "no-pull"];
const PIPELINE = [...ROUNDS, "setup", "verify", "verify-on-host", "merge", "ci-timeout", "allow-labeler", ...LIVE];

/** The options each command takes, on top of --help/--version/--verbose. "" is the bare `bunker "<prompt>"`. */
const ALLOWED: Record<Mode | "", string[]> = {
  "": [...COMMON, "max-iterations", "no-resume"],
  task: [...COMMON, "max-iterations", "no-resume"],
  review: [...COMMON, ...ROUNDS],
  issue: [...COMMON, ...PIPELINE],
  queue: [...COMMON, ...PIPELINE, "limit", "parallel"],
  watch: [...COMMON, ...PIPELINE, "parallel", "no-merge", "no-notify", "interval", "for", "max-cost-day", "max-cost-month", "audit-every", "triage-every", "auditor-model", "max-issues"],
  audit: [...COMMON, "auditor-model", "max-issues", "focus", "setup", ...LIVE],
};

/** The mode of this invocation, and the positionals that remain (the issue number is moved to values.issue, prompts stay). */
export interface ModeInvocation {
  mode: Mode | undefined;
  positionals: string[];
}

/**
 * Resolves the subcommand from the positionals and sets the internal mode values (values.watch, values.issue, …) the rest of
 * main.ts runs on. Throws a FlagError for a removed mode flag, a missing or surplus argument, or an option the command doesn't take.
 * `literal` is true after `--`: everything is then a prompt.
 */
export function resolveMode(values: CliValues, positionals: string[], literal: boolean): ModeInvocation {
  const removed: [string, string][] = [];
  if (values.issue !== undefined) removed.push(["--issue", REMOVED["--issue"]]);
  for (const f of ["queue", "watch", "audit", "review"] as const) if (values[f]) removed.push([`--${f}`, REMOVED[`--${f}`]]);
  if (values.task !== undefined) removed.push(["--task", REMOVED["--task"]]);
  if (removed.length) {
    const [flag, cmd] = removed[0]!;
    throw new FlagError(`${flag} was replaced by \`bunker ${cmd}\``);
  }
  const first = literal ? undefined : positionals[0];
  const mode = (MODES as readonly string[]).includes(first ?? "") ? (first as Mode) : undefined;
  const rest = mode ? positionals.slice(1) : positionals;
  const name = mode ? `bunker ${mode}` : 'bunker "<prompt>"';
  const given = Object.entries(values).filter(([, v]) => v !== false && v !== undefined).map(([k]) => k);
  const allowed = ALLOWED[mode ?? ""];
  const stray = given.filter((k) => !allowed.includes(k));
  if (stray.length) {
    throw new FlagError(`${stray.map((k) => `--${k}`).join(", ")} ${stray.length > 1 ? "don't" : "doesn't"} apply to ${name}${mode ? ` (see bunker ${mode} --help)` : ""}`);
  }
  switch (mode) {
    case "issue":
      if (rest.length !== 1) throw new FlagError("issue takes one issue number: bunker issue <n>");
      values.issue = rest[0];
      return { mode, positionals: [] };
    case "queue":
    case "watch":
    case "audit":
      if (rest.length) throw new FlagError(`${mode} takes no arguments (got "${rest.join(" ")}")`);
      values[mode] = true;
      return { mode, positionals: [] };
    case "review":
      if (!rest.length) throw new FlagError('review needs a prompt: bunker review "<prompt>"');
      values.review = true;
      return { mode, positionals: rest };
    case "task":
      if (!rest.length) throw new FlagError('task needs a prompt: bunker task "<prompt>" ["<prompt>" ...]');
      values.task = rest;
      return { mode, positionals: [] };
    default:
      return { mode, positionals: rest };
  }
}
