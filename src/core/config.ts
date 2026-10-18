import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** The `skills` setting: paths for both roles (`default`) and for one role. */
export interface SkillsConfig {
  default?: string[];
  implementer?: string[];
  reviewer?: string[];
}

export interface RepoConfig {
  setup?: string;
  verify?: string;
  verify_network?: boolean;
  verify_retries?: number;
  check?: string;
  copy?: string[];
  context?: string[];
  models: { implementer?: string; reviewer?: string; auditor?: string; default?: string };
  skills: SkillsConfig;
  watch: { interval?: number; parallel?: number; max_cost_day?: number; max_cost_month?: number; audit_every?: number; triage_every?: number };
  merge: { ci_timeout?: number; mode?: "auto" | "manual" };
  notify: { enabled?: boolean; github_user?: string };
  clean: { logs_days?: number };
}

/** An invalid `.bunker/config.toml`: the CLI exits 2. */
export class ConfigError extends Error {}

type Kind = "string" | "strings" | "number" | "integer" | "count" | "boolean";

interface KeySpec {
  key: string;
  kind: Kind;
  doc: string;
  /** Shown as the default when nothing sets the key. */
  default?: string | number | boolean | string[];
}

/** Every key of `.bunker/config.toml`, in the order `--help` and `bunker doctor` list them. */
export const CONFIG_KEYS: KeySpec[] = [
  { key: "setup", kind: "string", doc: "shell command run in each worktree before the agent" },
  { key: "verify", kind: "string", doc: "command that must pass before anything is pushed" },
  { key: "verify_network", kind: "boolean", doc: "let sandboxed verify use the network and Claude credentials (off: verify runs agent-written code)", default: false },
  { key: "verify_retries", kind: "count", doc: "fix rounds the implementer gets when verify fails, before the run fails as verify-failed (0: none)", default: 1 },
  { key: "check", kind: "string", doc: "command (e.g. a typecheck) run in the isolated sandbox before each review; its output goes into the reviewer prompt" },
  { key: "copy", kind: "strings", doc: "gitignored paths or globs copied into each worktree (legacy: .bunker/copy)", default: [] },
  { key: "context", kind: "strings", doc: "repo files (read from the default branch) inlined into the implementer and reviewer prompts", default: [] },
  { key: "models.implementer", kind: "string", doc: "model for the implementer role" },
  { key: "models.reviewer", kind: "string", doc: "model for the reviewer role" },
  { key: "models.auditor", kind: "string", doc: "model for the auditor role" },
  { key: "models.default", kind: "string", doc: "model for every role without its own" },
  { key: "skills.default", kind: "strings", doc: "skill directories (e.g. ~/.claude/skills/tdd) mounted read-only into ~/.claude/skills of every role; `skills = [...]` is the same" },
  { key: "skills.implementer", kind: "strings", doc: "skill directories for the implementer role only" },
  { key: "skills.reviewer", kind: "strings", doc: "skill directories for the reviewer role only" },
  { key: "watch.interval", kind: "number", doc: "minutes to sleep between bunker watch passes", default: 10 },
  { key: "watch.parallel", kind: "integer", doc: "issues bunker watch works at once", default: 1 },
  { key: "watch.max_cost_day", kind: "number", doc: "USD cap per rolling 24h for bunker watch" },
  { key: "watch.max_cost_month", kind: "number", doc: "USD cap per rolling 30 days for bunker watch" },
  { key: "watch.audit_every", kind: "number", doc: "days between periodic bunker audit runs in bunker watch" },
  { key: "watch.triage_every", kind: "number", doc: "hours between periodic `bunker triage` runs in bunker watch (comment and close only)" },
  { key: "merge.mode", kind: "string", doc: '"manual": PRs stay open for a human to merge; bunker keeps them green (also written `merge = "manual"`)', default: "auto" },
  { key: "merge.ci_timeout", kind: "number", doc: "minutes --merge waits for CI", default: 30 },
  { key: "clean.logs_days", kind: "number", doc: "days to keep .bunker/runs logs; bunker watch / bunker queue start-up and `bunker clean` prune older ones", default: 30 },
  { key: "notify.enabled", kind: "boolean", doc: "desktop notifications from bunker watch (notify-send / osascript)", default: true },
  { key: "notify.github_user", kind: "string", doc: "login @-mentioned when an issue becomes bunker:failed / bunker-blocked (default: the repo owner, if a user)" },
];

const EXPECTED: Record<Kind, string> = {
  string: "a string",
  strings: "an array of strings",
  number: "a positive number",
  integer: "a positive integer",
  count: "a non-negative integer",
  boolean: "true or false",
};

const TABLES = ["models", "skills", "watch", "merge", "notify", "clean"];

function check(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof v === "string";
    case "strings":
      return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "number":
      return typeof v === "number" && v > 0 && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v) && v > 0;
    case "count":
      return typeof v === "number" && Number.isInteger(v) && v >= 0;
    case "boolean":
      return typeof v === "boolean";
  }
}

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates a `skills` value: an array (for both roles) or a table of `default`, `implementer`, `reviewer` arrays. Absent is `{}`. */
export function parseSkills(v: unknown, name: string): SkillsConfig {
  if (v === undefined) return {};
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (Array.isArray(v)) {
    if (!strings(v)) throw new ConfigError(`${name}: skills must be an array of strings`);
    return { default: v };
  }
  if (!isTable(v)) throw new ConfigError(`${name}: skills must be an array of strings or a table`);
  const out: SkillsConfig = {};
  for (const [k, x] of Object.entries(v)) {
    if (k !== "default" && k !== "implementer" && k !== "reviewer") continue;
    if (!strings(x)) throw new ConfigError(`${name}: skills.${k} must be an array of strings`);
    out[k] = x;
  }
  return out;
}

/** Validates the text of a config.toml. Unknown keys come back as warnings; a wrongly typed key throws a ConfigError. */
export function parseConfig(text: string, name = ".bunker/config.toml"): { config: RepoConfig; warnings: string[] } {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    throw new ConfigError(`${name}: invalid TOML: ${e instanceof Error ? e.message : e}`);
  }
  const config: RepoConfig = { models: {}, skills: {}, watch: {}, merge: {}, notify: {}, clean: {} };
  const warnings: string[] = [];
  const known = new Set(CONFIG_KEYS.map((k) => k.key));
  const root = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(root)) {
    // A repo file must not widen its own `bunker` label gate: allow_labelers is user-level only.
    if (k === "queue" && isTable(v)) {
      for (const sub of Object.keys(v)) {
        warnings.push(sub === "allow_labelers"
          ? `${name}: queue.allow_labelers is ignored (a repo file could widen its own gate); set allow_labelers in ~/.config/bunker/config.toml`
          : `${name}: unknown key queue.${sub}, ignored`);
      }
      continue;
    }
    // `merge = "manual"` is the short form of `[merge] mode = "manual"` (a TOML key can't be both a string and a table).
    if (k === "merge" && typeof v === "string") {
      if (v !== "auto" && v !== "manual") throw new ConfigError(`${name}: merge must be "auto" or "manual"`);
      config.merge.mode = v;
      continue;
    }
    if (k === "skills" && Array.isArray(v)) {
      config.skills = parseSkills(v, name);
      continue;
    }
    if (TABLES.includes(k)) {
      if (!isTable(v)) throw new ConfigError(`${name}: ${k} must be a table`);
      for (const [sub, sv] of Object.entries(v)) {
        const spec = CONFIG_KEYS.find((s) => s.key === `${k}.${sub}`);
        if (!spec) warnings.push(`${name}: unknown key ${k}.${sub}, ignored`);
        else {
          if (!check(spec.kind, sv)) throw new ConfigError(`${name}: ${spec.key} must be ${EXPECTED[spec.kind]}`);
          if (spec.key === "merge.mode" && sv !== "auto" && sv !== "manual") throw new ConfigError(`${name}: merge.mode must be "auto" or "manual"`);
          (config[k as "models"] as Record<string, unknown>)[sub] = sv;
        }
      }
    } else if (known.has(k)) {
      const spec = CONFIG_KEYS.find((s) => s.key === k)!;
      if (!check(spec.kind, v)) throw new ConfigError(`${name}: ${k} must be ${EXPECTED[spec.kind]}`);
      (config as unknown as Record<string, unknown>)[k] = v;
    } else warnings.push(`${name}: unknown key ${k}, ignored`);
  }
  return { config, warnings };
}

export interface Legacy {
  copy?: string[];
}

export interface LoadedConfig {
  config: RepoConfig;
  legacy: Legacy;
  warnings: string[];
  /** Whether `.bunker/config.toml` exists. */
  present: boolean;
  /** Removed `.bunker/setup` / `.bunker/verify` files found (loadRepoConfig throws on them unless `lenient`). */
  removedFiles: ("setup" | "verify")[];
}

/** Files that were once read and are now an error. */
export const REMOVED_FILES = ["setup", "verify"] as const;

/** The error for a leftover `.bunker/<name>` file. */
export const removedFileMessage = (name: string): string => `.bunker/${name} is no longer read: move it to \`${name} = "…"\` in .bunker/config.toml and delete the file`;

/**
 * Reads `<dir>/.bunker/config.toml` and the legacy `copy` file. Throws ConfigError if the toml is invalid or a removed
 * `.bunker/setup` / `.bunker/verify` file exists (unless `lenient`, which lists them in `removedFiles`).
 */
export async function loadRepoConfig(dir: string, o: { lenient?: boolean } = {}): Promise<LoadedConfig> {
  const file = Bun.file(join(dir, ".bunker", "config.toml"));
  const present = await file.exists();
  const { config, warnings } = present ? parseConfig(await file.text()) : { config: parseConfig("").config, warnings: [] };
  const removedFiles: LoadedConfig["removedFiles"] = [];
  for (const name of REMOVED_FILES) if (await Bun.file(join(dir, ".bunker", name)).exists()) removedFiles.push(name);
  if (removedFiles.length && !o.lenient) throw new ConfigError(removedFiles.map(removedFileMessage).join("; "));
  const legacy: Legacy = {};
  const copy = Bun.file(join(dir, ".bunker", "copy"));
  if (await copy.exists()) legacy.copy = (await copy.text()).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return { config, legacy, warnings, present, removedFiles };
}

/** Like loadRepoConfig, but prints warnings; an invalid file prints its error and exits 2. */
export async function loadRepoConfigOrExit(dir: string): Promise<LoadedConfig> {
  try {
    const r = await loadRepoConfig(dir);
    for (const w of r.warnings) console.warn(`bunker: ${w}`);
    return r;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`bunker: ${e.message}`);
    process.exit(2);
  }
}

export interface Setting {
  key: string;
  value: string | number | boolean | string[] | undefined;
  source: string;
}

const get = (c: RepoConfig, key: string): unknown => {
  const [a, b] = key.split(".") as [string, string?];
  const v = (c as unknown as Record<string, unknown>)[a];
  return b === undefined ? v : (v as Record<string, unknown>)[b];
};

/** The value and source of every key, ignoring CLI flags: env > config.toml > .bunker/copy > default. */
export function effectiveSettings(o: { config: RepoConfig; legacy: Legacy; env: Env }): Setting[] {
  return CONFIG_KEYS.map((spec) => {
    const { key } = spec;
    if (key.startsWith("models.")) {
      const role = key.slice(7);
      const roleVar = role === "default" ? undefined : `BUNKER_${role.toUpperCase()}_MODEL`;
      if (roleVar && o.env[roleVar]) return { key, value: o.env[roleVar]!, source: `env ${roleVar}` };
      if (o.env.BUNKER_MODEL) return { key, value: o.env.BUNKER_MODEL, source: "env BUNKER_MODEL" };
      const c = get(o.config, key) as string | undefined;
      if (c !== undefined) return { key, value: c, source: "config.toml" };
      if (role !== "default") {
        const d = o.config.models.default;
        if (d !== undefined) return { key, value: d, source: "config.toml (models.default)" };
      }
      return { key, value: undefined, source: "default" };
    }
    const c = get(o.config, key) as Setting["value"];
    if (c !== undefined) return { key, value: c, source: "config.toml" };
    if (key === "copy" && o.legacy.copy !== undefined) return { key, value: o.legacy.copy, source: ".bunker/copy" };
    return { key, value: spec.default, source: "default" };
  });
}

export const formatValue = (v: Setting["value"]): string => (v === undefined ? "unset" : Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

/** The `.bunker/config.toml` keys, for --help. */
export const CONFIG_HELP = CONFIG_KEYS.map((k) => `  ${k.key.padEnd(22)} ${k.doc}${k.default !== undefined && !Array.isArray(k.default) ? ` (default ${k.default})` : ""}`).join("\n");
