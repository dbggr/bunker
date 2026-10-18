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

export const TRIAGE_VERDICTS = ["fixed", "as-designed", "duplicate", "valid"] as const;
export type TriageKind = (typeof TRIAGE_VERDICTS)[number];

export interface TriageVerdict {
  issue: number;
  verdict: TriageKind;
  /** `file:line`, the commit or PR that fixed it, or why it is as designed. */
  evidence: string;
  duplicate_of?: number;
  /** With `valid`: suggested priority. */
  priority?: Severity;
  bug?: boolean;
}

/** The `<triage>` block: entries are kept raw, and checked one by one by `readTriageVerdict` so one bad entry spares the rest. */
export const triageOutput = Output.object<{ verdicts: unknown[] }>({
  tag: "triage",
  schema: {
    parse(v) {
      if (!isObj(v) || !Array.isArray(v.verdicts)) throw new Error('"verdicts" must be an array');
      return { verdicts: v.verdicts };
    },
  },
});

/** One triage entry, validated; the error says why it is unusable. */
export function readTriageVerdict(x: unknown): { ok: true; value: TriageVerdict } | { ok: false; issue?: number; error: string } {
  if (!isObj(x) || !Number.isInteger(x.issue) || (x.issue as number) < 1) return { ok: false, error: 'entry needs an integer "issue"' };
  const issue = x.issue as number;
  const bad = (error: string) => ({ ok: false as const, issue, error });
  if (!TRIAGE_VERDICTS.includes(x.verdict as TriageKind)) return bad('"verdict" must be fixed, as-designed, duplicate or valid');
  if (typeof x.evidence !== "string" || !x.evidence.trim()) return bad('"evidence" must be a non-empty string');
  const value: TriageVerdict = { issue, verdict: x.verdict as TriageKind, evidence: x.evidence };
  if (value.verdict === "duplicate") {
    if (!Number.isInteger(x.duplicate_of) || (x.duplicate_of as number) < 1 || x.duplicate_of === issue) return bad('"duplicate_of" must be the number of another issue');
    value.duplicate_of = x.duplicate_of as number;
  }
  if (value.verdict === "valid") {
    if (!SEVERITIES.includes(x.priority as Severity)) return bad('"priority" must be "high", "medium" or "low"');
    value.priority = x.priority as Severity;
    if (x.bug !== undefined && typeof x.bug !== "boolean") return bad('"bug" must be a boolean');
    if (x.bug === true) value.bug = true;
  }
  return { ok: true, value };
}

export const NO_CHANGE_VERDICTS = ["fixed", "as-designed", "duplicate", "cannot-reproduce"] as const;
export type NoChangeKind = (typeof NO_CHANGE_VERDICTS)[number];

/** The implementer's `<no-change>`: the issue needs no change, and why. */
export interface NoChange {
  verdict: NoChangeKind;
  reason: string;
  /** `file:line`, `#PR` or issue, or a commit hash; checked against the default branch before anything is closed. */
  evidence: string[];
  /** With `duplicate`: the issue that covers this one. */
  duplicate_of?: number;
}

const MAX_EVIDENCE = 20;

export const noChangeSchema: Schema<NoChange> = {
  parse(v) {
    if (!isObj(v)) throw new Error("expected a JSON object");
    if (!NO_CHANGE_VERDICTS.includes(v.verdict as NoChangeKind)) throw new Error('"verdict" must be fixed, as-designed, duplicate or cannot-reproduce');
    if (typeof v.reason !== "string" || !v.reason.trim()) throw new Error('"reason" must be a non-empty string');
    const evidence = v.evidence ?? [];
    if (!Array.isArray(evidence) || !evidence.every((e) => typeof e === "string" && e.trim()) || evidence.length > MAX_EVIDENCE) {
      throw new Error(`"evidence" must be an array of at most ${MAX_EVIDENCE} non-empty strings`);
    }
    const value: NoChange = { verdict: v.verdict as NoChangeKind, reason: v.reason.trim(), evidence: (evidence as string[]).map((e) => e.trim()) };
    if (value.verdict === "duplicate") {
      if (!Number.isInteger(v.duplicate_of) || (v.duplicate_of as number) < 1) throw new Error('"duplicate_of" must be the number of the duplicate issue');
      value.duplicate_of = v.duplicate_of as number;
    } else if ((value.verdict === "fixed" || value.verdict === "as-designed") && !value.evidence.length) {
      throw new Error(`"evidence" must name at least one file:line, commit or PR for "${value.verdict}"`);
    }
    return value;
  },
};

export const noChangeOutput = Output.object({ tag: "no-change", schema: noChangeSchema });
