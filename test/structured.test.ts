import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { Output, extractOutput, verdictOutput, reportOutput, auditOutput, pickFollowUps } from "../src/structured.ts";

setDefaultTimeout(60_000); // see test/setup.ts

describe("extractOutput()", () => {
  test("valid verdict parsed", () => {
    const r = extractOutput('ok\n<verdict>{"approved": false, "required_changes": ["a"], "issues": [{"title":"T","body":"uses `x`"}]}</verdict>', verdictOutput);
    expect(r).toEqual({ ok: true, value: { approved: false, required_changes: ["a"], issues: [{ title: "T", body: "uses `x`" }], blocked_by: [] } });
  });
  test("last tag wins over quoted example", () => {
    const text = 'e.g. <verdict>{"approved": true}</verdict>\nfinal: <verdict>{"approved": false}</verdict>';
    const r = extractOutput(text, verdictOutput);
    expect(r.ok && r.value.approved).toBe(false);
  });
  test("quoted example followed by nothing else is not hidden by an earlier invalid one", () => {
    expect(extractOutput('<verdict>nope</verdict> then <verdict>{"approved":true}</verdict>', verdictOutput).ok).toBe(true);
  });
  test("missing and invalid report the reason", () => {
    expect(extractOutput("nothing", verdictOutput)).toMatchObject({ ok: false, present: false });
    const bad = extractOutput("<verdict>{oops</verdict>", verdictOutput);
    expect(bad).toMatchObject({ ok: false, present: true });
    expect(!bad.ok && bad.error).toContain("invalid JSON");
    const wrong = extractOutput('<verdict>{"approved":"yes"}</verdict>', verdictOutput);
    expect(!wrong.ok && wrong.error).toContain('"approved" must be a boolean');
  });
  test("report fields optional; string output", () => {
    expect(extractOutput("<report>{}</report>", reportOutput)).toEqual({ ok: true, value: { issues: [], blocked_by: [] } });
    expect(extractOutput("<x> hi </x>", Output.string({ tag: "x" }))).toEqual({ ok: true, value: "hi" });
  });
});

describe("severity", () => {
  test("report and audit follow-ups carry a validated severity", () => {
    const r = extractOutput('<report>{"issues":[{"title":"T","body":"b","severity":"high"}]}</report>', reportOutput);
    expect(r).toEqual({ ok: true, value: { issues: [{ title: "T", body: "b", severity: "high" }], blocked_by: [] } });
    const a = extractOutput('<audit>{"issues":[{"title":"T","body":"b","severity":"low"}]}</audit>', auditOutput);
    expect(a.ok && a.value.issues[0]!.severity).toBe("low");
    const bad = extractOutput('<report>{"issues":[{"title":"T","body":"b","severity":"urgent"}]}</report>', reportOutput);
    expect(!bad.ok && bad.error).toContain("severity");
  });
});

describe("pickFollowUps()", () => {
  const f = (title: string, severity?: "high" | "medium" | "low") => ({ title, body: "b", ...(severity ? { severity } : {}) });
  test("files the highest severity first, up to the cap; low and extras are not filed", () => {
    const { file, notFiled } = pickFollowUps([f("a", "low"), f("b", "medium"), f("c", "high"), f("d", "medium")], 1);
    expect(file.map((x) => x.title)).toEqual(["c"]);
    expect(notFiled.map((x) => x.title)).toEqual(["b", "d", "a"]);
  });
  test("low is never filed even under the cap; a missing severity counts as medium", () => {
    const { file, notFiled } = pickFollowUps([f("a", "low"), f("b")], 5);
    expect(file.map((x) => x.title)).toEqual(["b"]);
    expect(notFiled.map((x) => x.title)).toEqual(["a"]);
  });
});
