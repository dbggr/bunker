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

export interface FollowUp {
  title: string;
  body: string;
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
    return { title: x.title, body: x.body };
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
