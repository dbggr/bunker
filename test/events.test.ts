import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, noSandbox, review, type Agent, type BunkerEvent } from "../src/index.ts";
import { createProgress, findStreamResult, hyperlink, parseClaudeStreamLine } from "../src/core/events.ts";
import { runIssue } from "../src/pipeline/issue.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const assistant = (...content: object[]) => JSON.stringify({ type: "assistant", message: { content } });
const resultLine = (result: string, cost: number, ms: number) =>
  JSON.stringify({ type: "result", result, total_cost_usd: cost, duration_ms: ms });

describe("parseClaudeStreamLine()", () => {
  test("tool call with its target", () => {
    const line = assistant({ type: "tool_use", name: "Edit", input: { file_path: "src/cli.ts", old_string: "a" } });
    expect(parseClaudeStreamLine(line)).toEqual([{ type: "toolCall", name: "Edit", summary: "Edit src/cli.ts" }]);
    expect(parseClaudeStreamLine(assistant({ type: "tool_use", name: "TodoWrite", input: {} }))).toEqual([
      { type: "toolCall", name: "TodoWrite", summary: "TodoWrite" },
    ]);
  });

  test("text", () => {
    expect(parseClaudeStreamLine(assistant({ type: "text", text: "hello" }))).toEqual([{ type: "text", text: "hello" }]);
  });

  test("result with cost and duration", () => {
    expect(parseClaudeStreamLine(resultLine("done", 0.25, 1200))).toEqual([
      { type: "result", text: "done", usage: { costUsd: 0.25, durationMs: 1200 } },
    ]);
  });

  test("malformed and unrelated lines are ignored", () => {
    for (const line of ["", "not json", "{", "null", "42", '{"type":"system","subtype":"init"}', '{"type":"assistant"}']) {
      expect(parseClaudeStreamLine(line)).toEqual([]);
    }
  });

  test("claudeCode parse() takes text and usage from the final result event", () => {
    const stdout = [
      '{"type":"system"}',
      assistant({ type: "text", text: "working" }),
      "garbage",
      resultLine("all <promise>COMPLETE</promise>", 0.5, 900),
    ].join("\n");
    expect(findStreamResult(stdout)?.text).toContain("COMPLETE");
    expect(claudeCode({ json: true }).parse!(stdout)).toEqual({
      text: "all <promise>COMPLETE</promise>",
      usage: { costUsd: 0.5, durationMs: 900 },
    });
    expect(claudeCode({ json: true }).parseLine).toBeDefined();
  });
});

describe("createProgress()", () => {
  const at = 1_000_000;
  const events = (): BunkerEvent[] => [
    { type: "stage", name: "implement", issue: 7, round: 1, role: "implementer", at },
    { type: "toolCall", name: "Edit src/cli.ts", issue: 7, round: 1, role: "implementer", at: at + 5000 },
    { type: "result", costUsd: 0.25, issue: 7, round: 1, role: "implementer", at: at + 6000 },
    { type: "stage", name: "review", issue: 7, round: 1, role: "reviewer", at: at + 7000 },
  ];

  test("TTY: one line rewritten with \\r, stages are permanent lines", () => {
    let out = "";
    const p = createProgress({ write: (s) => (out += s), tty: true });
    for (const e of events().slice(0, 2)) p.onEvent(e);
    expect(out).toContain("bunker: #7 round 1 implementer · implement\n");
    expect(out).toContain("\r");
    const live = out.slice(out.lastIndexOf("\r"));
    expect(live).toContain("#7");
    expect(live).toContain("round 1");
    expect(live).toContain("implementer");
    expect(live).toContain("Edit src/cli.ts");
    expect(live).toContain("1 tools");
    expect(live).toContain("5s");
    expect(live).toContain("$0.00");
    p.onEvent(events()[2]!);
    expect(out.slice(out.lastIndexOf("\r"))).toContain("$0.25");
    p.onEvent(events()[3]!);
    expect(out.endsWith("reviewer · review\n")).toBe(true);
  });

  test("non-TTY: only stage lines, never \\r", () => {
    let out = "";
    const p = createProgress({ write: (s) => (out += s), tty: false });
    for (const e of events()) p.onEvent(e);
    p.clear();
    expect(out).not.toContain("\r");
    expect(out.trim().split("\n")).toHaveLength(2);
  });

  test("TTY: the last bytes are the final status line, not a \\r progress line", () => {
    let out = "";
    const p = createProgress({ write: (s) => (out += s), tty: true });
    p.onEvent({ type: "stage", name: "waiting for merge", issue: 7, at });
    p.onEvent({ type: "toolCall", name: "Edit x", issue: 7, at: at + 1000 });
    p.onEvent({ type: "meta", url: "https://github.com/o/r/pull/9", issue: 7, at: at + 2000 });
    p.onEvent({ type: "stage", name: "merged", issue: 7, at: at + 3000 });
    p.onEvent({ type: "toolCall", name: "late", issue: 7, at: at + 4000 });
    p.clear();
    expect(out.endsWith("bunker: #7 · merged · PR https://github.com/o/r/pull/9\n")).toBe(true);
    expect(out.slice(out.lastIndexOf("\r") + 1).startsWith("\x1b[K")).toBe(true);
  });

  test("a PR url is attached only to the merged line of its own issue or task", () => {
    let out = "";
    const p = createProgress({ write: (s) => (out += s), tty: false });
    p.onEvent({ type: "meta", url: "https://github.com/o/r/pull/1", issue: 1, at });
    p.onEvent({ type: "meta", url: "https://github.com/o/r/pull/2", issue: 2, at });
    p.onEvent({ type: "meta", url: "https://github.com/o/r/pull/3", task: 0, at });
    p.onEvent({ type: "stage", name: "merged", issue: 1, at });
    p.onEvent({ type: "stage", name: "merged", issue: 2, at });
    p.onEvent({ type: "stage", name: "merged", task: 0, at });
    p.onEvent({ type: "stage", name: "merged", task: 1, at });
    expect(out).toContain("bunker: #1 · merged · PR https://github.com/o/r/pull/1\n");
    expect(out).toContain("bunker: #2 · merged · PR https://github.com/o/r/pull/2\n");
    expect(out).toContain("bunker: [0] · merged · PR https://github.com/o/r/pull/3\n");
    expect(out).toContain("bunker: [1] · merged\n");
  });

  test("note events are permanent lines, no \\r off a TTY", () => {
    let out = "";
    const p = createProgress({ write: (s) => (out += s), tty: false });
    p.onEvent({ type: "note", issue: 3, text: "verify passed (1 pass, 0.1s)", at });
    expect(out).toBe("bunker: #3 · verify passed (1 pass, 0.1s)\n");
  });

  test("hyperlink() is an OSC 8 file:// link", () => {
    expect(hyperlink("/a/b.log")).toBe("\x1b]8;;file:///a/b.log\x1b\\/a/b.log\x1b]8;;\x1b\\");
  });
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-events-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

// Streams stream-json: a tool call, then a result. Implementer commits.
function streamingAgent(): Agent {
  const lines = (verdict: string) =>
    `echo '${assistant({ type: "tool_use", name: "Edit", input: { file_path: "a.txt" } })}'; echo '${resultLine(verdict, 0.1, 10)}'`;
  return {
    command: (_p, mode = "write") => [
      "sh", "-c",
      mode === "write" ? `echo hi > a.txt && git add . && git commit -qm "feat: x" && ${lines("done")}` : lines("<verdict>{\"approved\":true,\"required_changes\":[]}</verdict>"),
    ],
    parse: (stdout) => ({ text: findStreamResult(stdout)!.text }),
    parseLine: parseClaudeStreamLine,
  };
}

describe("onEvent", () => {
  test("review() streams stage, toolCall and result events with round and role", async () => {
    const repo = await makeRepo();
    const events: BunkerEvent[] = [];
    const raw: string[] = [];
    const r = await review({ cwd: repo, prompt: "x", agent: streamingAgent(), sandbox: noSandbox(), onEvent: (e) => events.push(e), onRaw: (l) => raw.push(l) });
    expect(r.status).toBe("approved");
    expect(events.map((e) => `${e.type}:${e.role ?? "-"}:${e.name ?? "-"}`)).toEqual([
      "stage:-:setup",
      "stage:implementer:implement",
      "toolCall:implementer:Edit a.txt",
      "result:implementer:-",
      "stage:reviewer:review",
      "toolCall:reviewer:Edit a.txt",
      "result:reviewer:-",
    ]);
    expect(events.filter((e) => e.round !== undefined).every((e) => e.round === 1)).toBe(true);
    expect(events.every((e) => typeof e.at === "number")).toBe(true);
    expect(raw).toHaveLength(4);
  });

  test("runIssue() emits the stage sequence and logs raw events", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunker-events-issue-"));
    dirs.push(root);
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    await $`git init -q --bare -b main ${origin}`;
    await $`git init -q -b main ${repo}`;
    await $`git -C ${repo} config user.name Test`;
    await $`git -C ${repo} config user.email test@example.com`;
    await $`git -C ${repo} commit -q --allow-empty -m init`;
    await $`git -C ${repo} remote add origin ${origin}`;
    await $`git -C ${repo} push -q -u origin main`;
    await $`mkdir ${join(root, "bin")}`;
    await Bun.write(
      join(root, "bin", "gh"),
      `#!/bin/sh
if [ "$1 $2" = "issue view" ]; then echo '{"number":7,"title":"feat: Add","body":"x","state":"OPEN","labels":[],"author":{"login":"o"}}'; exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo https://github.com/o/r/pull/9; exit 0; fi
if [ "$1 $2" = "pr view" ]; then echo '{"state":"MERGED"}'; exit 0; fi
case "$*" in *"/rules/branches/"*) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test"}]}}]'; exit 0;; esac
if [ "$1" = "api" ]; then echo OWNER; exit 0; fi
exit 0
`,
    );
    await chmod(join(root, "bin", "gh"), 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${join(root, "bin")}:${origPath}`;
    try {
      const events: BunkerEvent[] = [];
      const r = await runIssue({ cwd: repo, issue: 7, agent: streamingAgent(), sandbox: noSandbox(), verify: "true", merge: true, onEvent: (e) => events.push(e), ciPollMs: 1 });
      const stages = events.filter((e) => e.type === "stage").map((e) => e.name);
      expect(stages.slice(0, 6)).toEqual(["setup", "implement", "review", "verify", "PR", "waiting for merge"]);
      expect(stages.at(-1)).toBe(r.status === "merged" ? "merged" : "failed");
      expect(events.every((e) => e.issue === 7)).toBe(true);
      const log = await Bun.file(r.logPath!).text();
      expect(log).toContain('"type":"tool_use"');
    } finally {
      process.env.PATH = origPath;
    }
  });
});
