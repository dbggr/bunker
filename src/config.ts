import { join } from "node:path";

type Env = Record<string, string | undefined>;

export interface RepoConfig {
  setup?: string;
  verify?: string;
  copy?: string[];
  models: { implementer?: string; reviewer?: string; auditor?: string; default?: string };
  watch: { interval?: number; parallel?: number; max_cost_day?: number; max_cost_month?: number; audit_every?: number };
  merge: { ci_timeout?: number };
  queue: { allow_labelers?: string[] };
  notify: { desktop?: boolean; github_user?: string };
}

/** An invalid `.bunker/config.toml`: the CLI exits 2. */
export class ConfigError extends Error {}

type Kind = "string" | "strings" | "number" | "integer" | "boolean";

interface KeySpec {
  key: string;
  kind: Kind;
  doc: string;
  /** Shown as the default when nothing sets the key. */
  default?: string | number | boolean | string[];
}

/** Every key of `.bunker/config.toml`, in the order `--help` and `bunker doctor` list them. */
export const CONFIG_KEYS: KeySpec[] = [
  { key: "setup", kind: "string", doc: "shell command run in each worktree before the agent (legacy: .bunker/setup)" },
  { key: "verify", kind: "string", doc: "command that must pass before anything is pushed (legacy: .bunker/verify)" },
  { key: "copy", kind: "strings", doc: "gitignored paths or globs copied into each worktree (legacy: .bunker/copy)", default: [] },
  { key: "models.implementer", kind: "string", doc: "model for the implementer role" },
  { key: "models.reviewer", kind: "string", doc: "model for the reviewer role" },
  { key: "models.auditor", kind: "string", doc: "model for the auditor role" },
  { key: "models.default", kind: "string", doc: "model for every role without its own" },
  { key: "watch.interval", kind: "number", doc: "minutes to sleep between --watch passes", default: 10 },
  { key: "watch.parallel", kind: "integer", doc: "issues --watch works at once", default: 1 },
  { key: "watch.max_cost_day", kind: "number", doc: "USD cap per rolling 24h for --watch" },
  { key: "watch.max_cost_month", kind: "number", doc: "USD cap per rolling 30 days for --watch" },
  { key: "watch.audit_every", kind: "number", doc: "days between periodic --audit runs in --watch" },
  { key: "merge.ci_timeout", kind: "number", doc: "minutes --merge waits for CI", default: 30 },
  { key: "queue.allow_labelers", kind: "strings", doc: "GitHub logins besides maintainers who may add the `bunker` label", default: [] },
  { key: "notify.desktop", kind: "boolean", doc: "desktop notifications (notify-send / osascript) from --watch", default: true },
  { key: "notify.github_user", kind: "string", doc: "GitHub login @-mentioned when an issue becomes bunker-failed or bunker-blocked (default: the repo owner, if a user)" },
];

const EXPECTED: Record<Kind, string> = {
  string: "a string",
  strings: "an array of strings",
  number: "a positive number",
  integer: "a positive integer",
  boolean: "true or false",
};

const TABLES = ["models", "watch", "merge", "queue", "notify"];

function check(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof v === "string";
    case "strings":
      return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "number":
      return typeof v === "number" && v > 0 && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v) && v > 0;
  }
}

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the text of a config.toml. Unknown keys come back as warnings; a wrongly typed key throws a ConfigError. */
export function parseConfig(text: string, name = ".bunker/config.toml"): { config: RepoConfig; warnings: string[] } {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    throw new ConfigError(`${name}: invalid TOML: ${e instanceof Error ? e.message : e}`);
  }
  const config: RepoConfig = { models: {}, watch: {}, merge: {}, queue: {}, notify: {} };
  const warnings: string[] = [];
  const known = new Set(CONFIG_KEYS.map((k) => k.key));
  const root = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(root)) {
    if (TABLES.includes(k)) {
      if (!isTable(v)) throw new ConfigError(`${name}: ${k} must be a table`);
      for (const [sub, sv] of Object.entries(v)) {
        const spec = CONFIG_KEYS.find((s) => s.key === `${k}.${sub}`);
        if (!spec) warnings.push(`${name}: unknown key ${k}.${sub}, ignored`);
        else {
          if (!check(spec.kind, sv)) throw new ConfigError(`${name}: ${spec.key} must be ${EXPECTED[spec.kind]}`);
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
  setup?: string;
  verify?: string;
  copy?: string[];
}

export interface LoadedConfig {
  config: RepoConfig;
  legacy: Legacy;
  warnings: string[];
  /** One-line deprecation note when config.toml and legacy `.bunker/*` files both exist. */
  notes: string[];
  /** Whether `.bunker/config.toml` exists. */
  present: boolean;
}

const LEGACY_FILES = ["setup", "verify", "copy"] as const;

/** Reads `<dir>/.bunker/config.toml` and the legacy `setup`, `verify`, `copy` files. Throws ConfigError if the toml is invalid. */
export async function loadRepoConfig(dir: string): Promise<LoadedConfig> {
  const file = Bun.file(join(dir, ".bunker", "config.toml"));
  const present = await file.exists();
  const { config, warnings } = present ? parseConfig(await file.text()) : { config: parseConfig("").config, warnings: [] };
  const legacy: Legacy = {};
  const found: string[] = [];
  for (const name of LEGACY_FILES) {
    const f = Bun.file(join(dir, ".bunker", name));
    if (!(await f.exists())) continue;
    const text = await f.text();
    if (name === "copy") legacy.copy = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    else if (name === "verify") {
      if (text.trim()) legacy.verify = text.trim();
    } else legacy.setup = "sh .bunker/setup";
    found.push(`.bunker/${name}`);
  }
  const notes = present && found.length ? [`bunker: ${found.join(", ")} ${found.length > 1 ? "are" : "is"} deprecated; .bunker/config.toml takes precedence where it sets the same key`] : [];
  return { config, legacy, warnings, notes, present };
}

/** Like loadRepoConfig, but prints warnings/notes; an invalid file prints its error and exits 2. */
export async function loadRepoConfigOrExit(dir: string): Promise<LoadedConfig> {
  try {
    const r = await loadRepoConfig(dir);
    for (const m of [...r.warnings.map((w) => `bunker: ${w}`), ...r.notes]) console.warn(m);
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

/** The value and source of every key, ignoring CLI flags: env > config.toml > legacy files > default. */
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
    if (key === "setup" || key === "verify" || key === "copy") {
      const l = o.legacy[key];
      if (l !== undefined) return { key, value: l, source: `.bunker/${key}` };
    }
    return { key, value: spec.default, source: "default" };
  });
}

export const formatValue = (v: Setting["value"]): string => (v === undefined ? "unset" : Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

/** The `.bunker/config.toml` keys, for --help. */
export const CONFIG_HELP = CONFIG_KEYS.map((k) => `  ${k.key.padEnd(22)} ${k.doc}${k.default !== undefined && !Array.isArray(k.default) ? ` (default ${k.default})` : ""}`).join("\n");
