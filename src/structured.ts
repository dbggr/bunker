/** Structured agent output: one tagged JSON (or string) value in the agent's final text, validated. */

/** Anything with a throwing `parse` — a zod schema fits. */
export interface Schema<T> {
  parse(value: unknown): T;
}

export interface Output<T> {
  tag: string;
  /** Parses the raw text between the tags; throws with a message fit to show the agent. */
  read(raw: string): T;
}

export type Extracted<T> = { ok: true; value: T } | { ok: false; error: string; present: boolean };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const Output = {
  object<T>({ tag, schema }: { tag: string; schema: Schema<T> }): Output<T> {
    return {
      tag,
      read(raw) {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch (e) {
          throw new Error(`invalid JSON: ${errMsg(e)}`);
        }
        return schema.parse(json);
      },
    };
  },
  string({ tag }: { tag: string }): Output<string> {
    return { tag, read: (raw) => raw.trim() };
  },
};

/** The last `<tag>…</tag>` in `text` only: earlier ones (quoted examples) never count. */
export function extractOutput<T>(text: string, out: Output<T>): Extracted<T> {
  const open = `<${out.tag}>`;
  const close = `</${out.tag}>`;
  const end = text.lastIndexOf(close);
  const start = end < 0 ? -1 : text.lastIndexOf(open, end);
  if (start < 0) return { ok: false, present: false, error: `no <${out.tag}>…</${out.tag}> block found` };
  try {
    return { ok: true, value: out.read(text.slice(start + open.length, end)) };
  } catch (e) {
    return { ok: false, present: true, error: `<${out.tag}> is invalid: ${errMsg(e)}` };
  }
}

export type Severity = "high" | "medium" | "low";
const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

/** What each severity means; shared by every prompt that asks for follow-ups. */
export const SEVERITY_HELP =
  '"severity" is "high" (security, data loss, breaks unattended runs or merges), "medium" (wrong behaviour users will hit) ' +
  'or "low" (cosmetic, a test gap, a rare edge). Only high and medium become issues, so rate honestly.';

export interface FollowUp {
  title: string;
  body: string;
  /** Triage level; absent counts as `medium`. Only high and medium are filed. */
  severity?: Severity;
  /** The follow-up is a defect; it is filed with the `bug` label. */
  bug?: boolean;
}

export interface Report {
  issues: FollowUp[];
  blocked_by: FollowUp[];
}

export interface Verdict extends Report {
  approved: boolean;
  required_changes: string[];
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

function followUps(v: unknown, field: string): FollowUp[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`"${field}" must be an array of {"title","body"}`);
  return v.map((x, i) => {
    if (!isObj(x) || typeof x.title !== "string" || typeof x.body !== "string") throw new Error(`"${field}[${i}]" must be {"title": string, "body": string}`);
    if (x.bug !== undefined && typeof x.bug !== "boolean") throw new Error(`"${field}[${i}].bug" must be a boolean`);
    if (x.severity !== undefined && !SEVERITIES.includes(x.severity as Severity)) throw new Error(`"${field}[${i}].severity" must be "high", "medium" or "low"`);
    return { title: x.title, body: x.body, ...(x.severity ? { severity: x.severity as Severity } : {}), ...(x.bug === true ? { bug: true } : {}) };
  });
}

export const reportSchema: Schema<Report> = {
  parse(v) {
    if (!isObj(v)) throw new Error("expected a JSON object");
    return { issues: followUps(v.issues, "issues"), blocked_by: followUps(v.blocked_by, "blocked_by") };
  },
};

export const verdictSchema: Schema<Verdict> = {
  parse(v) {
    if (!isObj(v)) throw new Error("expected a JSON object");
    if (typeof v.approved !== "boolean") throw new Error('"approved" must be a boolean');
    const rc = v.required_changes ?? [];
    if (!Array.isArray(rc) || !rc.every((s) => typeof s === "string")) throw new Error('"required_changes" must be an array of strings');
    return { approved: v.approved, required_changes: rc as string[], ...reportSchema.parse(v) };
  },
};

export const verdictOutput = Output.object({ tag: "verdict", schema: verdictSchema });
export const reportOutput = Output.object({ tag: "report", schema: reportSchema });

export interface Audit {
  issues: FollowUp[];
}

export const auditSchema: Schema<Audit> = {
  parse(v) {
    if (!isObj(v)) throw new Error("expected a JSON object");
    if (!Array.isArray(v.issues)) throw new Error('"issues" must be an array of {"title","body"}');
    return { issues: followUps(v.issues, "issues") };
  },
};

export const auditOutput = Output.object({ tag: "audit", schema: auditSchema });

const rank = (f: { severity?: Severity }) => SEVERITIES.indexOf(f.severity ?? "medium");

/**
 * Splits proposed follow-ups into what to file (high/medium only, highest severity first, at most `cap`)
 * and what to list as not filed (the rest, in that same order).
 */
export function pickFollowUps<T extends { severity?: Severity }>(items: T[], cap: number): { file: T[]; notFiled: T[] } {
  const sorted = items.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x);
  const eligible = sorted.filter((f) => f.severity !== "low");
  const file = eligible.slice(0, cap);
  return { file, notFiled: sorted.filter((f) => !file.includes(f)) };
}
