import { readFileSync } from "node:fs";
import { redact } from "./redact.ts";

const MAX = 200;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Agent or tool text as one redacted line of at most 200 characters. */
export function oneLine(text: string): string {
  const t = redact(text.replace(ANSI, "")).replace(/\s+/g, " ").trim();
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t;
}

/** The run-log sections (`== title ==` followed by text), in order. */
function sections(log: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  let cur: { title: string; lines: string[] } | undefined;
  const flush = () => cur && out.push({ title: cur.title, text: cur.lines.join("\n").trim() });
  for (const line of log.split("\n")) {
    const m = /^== (.+) ==$/.exec(line);
    if (m) {
      flush();
      cur = { title: m[1]!, lines: [] };
    } else cur?.lines.push(line);
  }
  flush();
  return out;
}

const TYPE_ERROR = /\berror TS\d+:.*/;
const FAILED_TEST = /^\s*\(fail\)\s+.*|^\s*(?:✗|✖|×)\s+.*|^\s*not ok\s+.*/;

/** The first failing test or type error in verify output; else its last non-empty line. */
function verifyReason(output: string): string | undefined {
  const lines = output.split("\n").map((l) => l.replace(ANSI, ""));
  for (const l of lines) {
    const t = TYPE_ERROR.exec(l);
    if (t) return l.trim().replace(/^.*?(?=\S+[(:]\d+[,:]\d+\)?:? ?-? ?error TS)/, "");
    if (FAILED_TEST.test(l)) return `test failed: ${l.trim().replace(/^\(fail\)\s+/, "").replace(/\s*\[[\d.]+ms\]$/, "")}`;
  }
  return lines.map((l) => l.trim()).filter(Boolean).pop();
}

const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean);

/**
 * Why a run failed, in one line, from its run log (`text`, the log's contents) and the result's own fields as a fallback:
 * the first failing test or type error for `verify-failed`, the reviewer's first required change for `rejected`,
 * otherwise the error line.
 */
export function reasonFromLog(status: string, log: string, fallback: { error?: string; verifyOutput?: string } = {}): string {
  const secs = sections(log);
  const last = (re: RegExp) => [...secs].reverse().find((s) => re.test(s.title));
  let reason: string | undefined;
  if (status === "verify-failed") {
    reason = verifyReason(last(/^verify \(exit/)?.text ?? fallback.verifyOutput ?? "");
  } else if (status === "rejected") {
    const text = last(/reviewer output \(changes requested\)/)?.text;
    if (text) {
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      reason = lines.find((l) => /^[-*]\s/.test(l))?.replace(/^[-*]\s+/, "") ?? lines[0];
    }
  }
  if (!reason) {
    const fin = last(/^final status:/)?.text;
    reason = firstLine(fallback.error ?? "") ?? (fin ? firstLine(fin) : undefined) ?? firstLine(last(/error/i)?.text ?? "");
  }
  return oneLine(reason ?? status);
}

/** `reasonFromLog` reading the log file; a missing or unreadable log falls back to the result's fields. */
export function failureReason(status: string, logPath: string | undefined, fallback: { error?: string; verifyOutput?: string } = {}): string {
  let log = "";
  try {
    if (logPath) log = readFileSync(logPath, "utf8");
  } catch {}
  return reasonFromLog(status, log, fallback);
}
