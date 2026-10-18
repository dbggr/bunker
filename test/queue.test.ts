import { afterEach, describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent, type Sandbox } from "../src/index.ts";
import { output } from "../src/core/output.ts";
import { runIssue } from "../src/pipeline/issue.ts";
import { runQueue } from "../src/pipeline/queue.ts";
import { resumeBlocked } from "../src/github/issues.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = origPath;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const APPROVE = "<verdict>{\"approved\":true,\"required_changes\":[]}</verdict>";

// Implementer commits a unique file and prints `implOut`; reviewer prints `verdict`.
function fakeAgent(verdict: string | ((n: number) => string) = APPROVE, implOut = "", prompts: string[] = []): Agent {
  let n = 0;
  return {
    command(prompt, mode = "write") {
      if (mode === "write") {
        prompts.push(prompt);
        return ["sh", "-c", `echo hi > f-$(date +%s%N).txt && git add . && git commit -qm "feat: impl" && echo '${implOut}'`];
      }
      prompts.push(`REVIEW:${prompt}`);
      return ["sh", "-c", `echo '${typeof verdict === "function" ? verdict(++n) : verdict}'`];
    },
  };
}

interface Env {
  repo: string;
  createLog: string;
}

// Issues are [number, title, createdAt]; the fake `gh issue list` returns them unsorted.
async function setup(issues: [number, string, string][], mergeMode: "ff" | "none" = "none"): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "bunker-queue-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const createLog = join(root, "create.log");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} commit -q --allow-empty -m init`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await $`git -C ${repo} push -q -u origin main`;
  await $`mkdir ${bin}`;
  await Bun.write(join(root, "list.json"), JSON.stringify(issues.map(([number, title, createdAt]) => ({ number, title, createdAt }))));
  for (const [number, title] of issues) {
    await Bun.write(join(root, `issue-${number}.json`), JSON.stringify({ number, title, body: "Do it.", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker:queued" }] }));
  }
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1" = "api" ]; then case "$*" in *"/rules/branches/"*) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test"}]}}]'; exit 0;; *graphql*|*renamed*) exit 0;; *created_at*) echo 2020-01-01T00:00:00Z; exit 0;; *"/events"*) echo owner; exit 0;; *"/permission"*) echo admin; exit 0;; esac; fi
if [ "$1 $2" = "issue list" ] && echo "$*" | grep -q -- "--label bunker:in-progress"; then echo '[]'; exit 0; fi
if [ "$1 $2" = "issue list" ] && echo "$*" | grep -q -- "--label bunker-blocked"; then
  if [ -f "${root}/blocked-list.json" ]; then cat "${root}/blocked-list.json"; else echo '[]'; fi
  exit 0
fi
if [ "$1 $2" = "issue list" ]; then
  echo "$*" >> "${root}/list.log"
  if [ -f "${root}/list-fail-always" ]; then echo "HTTP 502" >&2; exit 1; fi
  if [ -f "${root}/list-fail-once" ]; then rm "${root}/list-fail-once"; echo "HTTP 502" >&2; exit 1; fi
  if [ -f "${root}/list-bad-once" ]; then rm "${root}/list-bad-once"; echo "<html>oops"; exit 0; fi
  if [ -f "${root}/list-raw-once" ]; then cat "${root}/list-raw-once"; rm "${root}/list-raw-once"; exit 0; fi
  if [ -f "${root}/list-empty-once" ]; then rm "${root}/list-empty-once"; echo '[]'; exit 0; fi
  if [ -f "${root}/list-partial-once" ]; then cat "${root}/list-partial-once"; rm "${root}/list-partial-once"; exit 0; fi
  cat "${root}/list.json"; exit 0
fi
if [ "$1 $2" = "issue view" ]; then
  if [ -f "${root}/view-fail-$3" ]; then echo "HTTP 502" >&2; exit 1; fi
  if [ -f "${root}/view-raw-$3" ]; then cat "${root}/view-raw-$3"; exit 0; fi
  if [ -f "${root}/view-bad-$3" ]; then echo "<html>oops"; exit 0; fi
  cat "${root}/issue-$3.json"; exit 0
fi
if [ "$1 $2" = "issue create" ]; then
  shift 2
  if [ -f "${root}/no-bug-label" ] && echo " $* " | grep -q -- " bug "; then echo "could not add label: 'bug' not found" >&2; exit 1; fi
  if [ -f "${root}/no-severity-label" ] && echo " $* " | grep -q -- "severity:"; then echo "could not add label: 'severity:high' not found" >&2; exit 1; fi
  for a in "$@"; do printf '%s\\n' "$a"; done >> "${createLog}"
  echo "---" >> "${createLog}"
  echo "https://github.com/o/r/issues/100"
  exit 0
fi
if [ "$1 $2" = "issue edit" ] || [ "$1 $2" = "issue comment" ] || [ "$1 $2" = "label create" ]; then
  echo "$*" >> "${root}/edits.log"
  if [ "$1 $2" = "issue edit" ]; then
    case "$*" in
      *"--add-label bunker-blocked"*) sed -i 's/"name":"bunker:queued"/"name":"bunker-blocked"/' "${root}/issue-$3.json" ;;
      *"--add-label bunker:queued"*) sed -i 's/"name":"bunker-blocked"/"name":"bunker:queued"/' "${root}/issue-$3.json" ;;
    esac
  fi
  exit 0
fi
if [ "$1 $2" = "pr create" ]; then printf '%s' "$*" >> "${root}/pr-body.txt"; echo "https://github.com/o/r/pull/$(git rev-parse --abbrev-ref HEAD | tr '/' '-')"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then
  if [ -f "${root}/merged" ]; then echo '{"state":"MERGED","mergeCommit":{"oid":"abc"}}'; else echo '{"state":"OPEN","mergeCommit":null}'; fi
  exit 0
fi
if [ "$1 $2" = "pr merge" ]; then
  ${mergeMode === "ff" ? `git --git-dir="${origin}" update-ref refs/heads/main "refs/heads/$(git rev-parse --abbrev-ref HEAD)"; touch "${root}/merged"; exit 0` : "exit 1"}
fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { repo, createLog };
}

describe("filing discovered issues", () => {
  test("files at most one follow-up (implementer and reviewer blocks, deduped), never bunker", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    const prompts: string[] = [];
    const r = await runIssue({
      cwd: repo, issue: 7, sandbox: noSandbox(),
      agent: fakeAgent(`<verdict>${JSON.stringify({ approved: true, required_changes: [], issues: [{ title: "Rev found", body: "rb" }, { title: "Dup", body: "second" }] })}</verdict>`, `<report>${JSON.stringify({ issues: [{ title: "Dup", body: "first" }] })}</report>`, prompts),
    });
    expect(r.status).toBe("pr-opened");
    expect(r.filed).toEqual([{ number: 100, title: "Dup" }]);
    const log = await Bun.file(createLog).text();
    expect(log.match(/--label\ndiscovered/g)?.length).toBe(1);
    expect(log).not.toMatch(/bunker/);
    expect(log).toContain("first\n\nFound while working on #7.");
    expect(prompts.some((p) => p.startsWith("REVIEW:") && p.includes("<verdict>"))).toBe(true);
    expect(prompts[0]).toContain("<report>");
    expect(prompts[0]).toContain("severity");
  });

  test("3 proposed follow-ups: the highest severity is filed with its label, the rest go to the PR body and log; low is never filed", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    const issues = [
      { title: "Cosmetic nit", body: "n", severity: "low" },
      { title: "Wrong output", body: "m", severity: "medium" },
      { title: "Leaks token", body: "h", severity: "high" },
    ];
    const report = `<report>${JSON.stringify({ issues })}</report>`;
    const r = await runIssue({ cwd: repo, issue: 7, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.filed).toEqual([{ number: 100, title: "Leaks token" }]);
    const log = await Bun.file(createLog).text();
    expect(log.split("---").filter((x) => x.trim())).toHaveLength(1);
    expect(log).toContain("discovered");
    expect(log).toContain("severity:high");
    expect(log).not.toMatch(/priority:|bunker/);
    const prBody = await Bun.file(join(repo, "..", "pr-body.txt")).text();
    expect(prBody).toContain("not filed");
    expect(prBody).toContain("Wrong output");
    expect(prBody).toContain("Cosmetic nit");
    expect(prBody).not.toContain("Leaks token");
    const runLog = await Bun.file(r.logPath!).text();
    expect(runLog).toContain("not filed");
    expect(runLog).toContain("Cosmetic nit");
  });

  test("a low-only report files nothing", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    const report = '<report>{"issues": [{"title": "Nit", "body": "n", "severity": "low"}]}</report>';
    const r = await runIssue({ cwd: repo, issue: 7, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.filed).toEqual([]);
    expect(await Bun.file(createLog).exists()).toBe(false);
  });

  test("a repo without the severity label still gets the follow-up", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    await Bun.write(join(repo, "..", "no-severity-label"), "");
    const report = '<report>{"issues": [{"title": "Real", "body": "b", "severity": "high"}]}</report>';
    const r = await runIssue({ cwd: repo, issue: 7, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.filed).toEqual([{ number: 100, title: "Real" }]);
    expect(await Bun.file(createLog).text()).not.toContain("severity:");
  });
});

describe("filing a bug follow-up", () => {
  test("retries without the bug label when the repo has none", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    await Bun.write(join(repo, "..", "no-bug-label"), "");
    const report = '<report>{"issues": [{"title": "Broken thing", "body": "rb", "bug": true}]}</report>';
    const r = await runIssue({ cwd: repo, issue: 7, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.filed).toEqual([{ number: 100, title: "Broken thing" }]);
    const log = await Bun.file(createLog).text();
    expect(log).toContain("discovered");
    expect(log).not.toMatch(/^bug$/m);
  });
});

describe("runQueue()", () => {
  const issues: [number, string, string][] = [
    [3, "Third", "2026-03-01T00:00:00Z"],
    [1, "First", "2026-01-01T00:00:00Z"],
    [2, "Second", "2026-02-01T00:00:00Z"],
  ];

  test("lists with a high --limit so issues beyond gh's default 30 are seen", async () => {
    const { repo } = await setup(issues);
    await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox() });
    const log = await Bun.file(join(repo, "..", "list.log")).text();
    const m = log.match(/--limit (\d+)/);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(1000);
  });

  test("keepGoing: a throw after the agents ran still reports the usage they spent", async () => {
    const { repo } = await setup(issues);
    const agent: Agent = {
      ...fakeAgent(),
      parse: (stdout) => ({ text: stdout, usage: { costUsd: 2, durationMs: 1 } }),
    };
    const inner = noSandbox();
    // The agents run fine; the sandboxed verify step blows up.
    const sandbox: Sandbox = { exec: (cmd, ctx) => (cmd.join(" ").includes("(true)") ? Promise.reject(new Error("sandbox exploded")) : inner.exec(cmd, ctx)) };
    const rs = await runQueue({ cwd: repo, agent, sandbox, verify: "true", keepGoing: true, limit: 1 });
    expect(rs[0]!.status).toBe("failed");
    expect(rs[0]!.error).toContain("sandbox exploded");
    expect(rs[0]!.usage?.costUsd).toBeCloseTo(4);
  });

  test("without merge: oldest first, stops after the first PR", async () => {
    const { repo } = await setup(issues);
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox() });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "pr-opened"]]);
  });

  test("with merge: continues after merged, honours limit", async () => {
    const { repo } = await setup(issues, "ff");
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 2, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [2, "merged"]]);
  });

  test("with merge: stops at the first non-merged outcome", async () => {
    const { repo } = await setup(issues, "ff");
    const rs = await runQueue({ cwd: repo, agent: fakeAgent('<verdict>{"approved":false,"required_changes":["nope"]}</verdict>'), sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "rejected"]]);
  });

  test("skips listed issues that are closed or no longer labelled when re-checked", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "x", state: "CLOSED", labels: [{ name: "bunker:queued" }] }));
    await Bun.write(join(root, "issue-2.json"), JSON.stringify({ number: 2, title: "Second", body: "x", author: { login: "owner" }, state: "OPEN", labels: [] }));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[3, "merged"]]);
  });

  test("skips a candidate whose re-check fails instead of aborting the queue", async () => {
    const { repo } = await setup(issues, "ff");
    await Bun.write(join(repo, "..", "view-fail-1"), "");
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 2, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[2, "merged"], [3, "merged"]]);
  });

  test("warnings go through the output sink, not the console", async () => {
    const { repo } = await setup(issues, "ff");
    await Bun.write(join(repo, "..", "view-fail-1"), "");
    const lines: string[] = [];
    output.warn = (l) => lines.push(l);
    const spies = [spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "log")];
    try {
      await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 2, ciPollMs: 10 });
      expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(lines.join("\n")).toContain("skipping #1, gh issue view failed");
  });

  test("keeps earlier results when a later re-check fails", async () => {
    const { repo } = await setup(issues, "ff");
    await Bun.write(join(repo, "..", "view-fail-2"), "");
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [3, "merged"]]);
  });

  test("skips a candidate whose re-check returns bad JSON, keeping earlier results", async () => {
    const { repo } = await setup(issues, "ff");
    await Bun.write(join(repo, "..", "view-bad-2"), "");
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [3, "merged"]]);
  });

  test("uses the other list when one list call fails or returns bad JSON", async () => {
    for (const f of ["list-fail-once", "list-bad-once"]) {
      const { repo } = await setup(issues);
      await Bun.write(join(repo, "..", f), "");
      const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), listRetryMs: 10 });
      expect(rs.map((r) => r.issue)).toEqual([1]);
    }
  });

  test("ignores a valid-but-wrong-shaped list response", async () => {
    for (const raw of ["null", '{"message":"rate limited"}', "42", '"x"', '[null, 7, {"title":"no number"}]', '[{"number":3}]', '[{"number":3,"title":"t"}]']) {
      const { repo } = await setup(issues);
      await Bun.write(join(repo, "..", "list-raw-once"), raw);
      const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), listRetryMs: 10 });
      expect(rs.map((r) => r.issue)).toEqual([1]);
    }
  });

  test("skips an issue whose view is valid JSON of the wrong shape", async () => {
    for (const raw of ["null", "[]", '{"state":"OPEN"}', '{"state":"OPEN","labels":"bunker:queued"}', '{"state":"OPEN","labels":[null]}',
      '{"state":"OPEN","labels":[{"name":"bunker:queued"}],"comments":"x","body":5}', '{"state":"OPEN","labels":[{"name":"bunker:queued"}],"comments":[null]}',
      '{"state":"OPEN","labels":[{"name":"bunker:queued"}],"comments":[{"body":5,"authorAssociation":"OWNER"}]}']) {
      const { repo } = await setup(issues);
      await Bun.write(join(repo, "..", "view-raw-1"), raw);
      const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10, listRetryMs: 10 });
      expect(rs.map((r) => r.issue)).not.toContain(1);
    }
  });

  test("returns an empty queue instead of throwing when both list calls fail", async () => {
    const { repo } = await setup(issues);
    await Bun.write(join(repo, "..", "list-fail-always"), "");
    expect(await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), listRetryMs: 10 })).toEqual([]);
  });

  test("retries an empty list once after a short delay", async () => {
    const { repo } = await setup(issues);
    await Bun.write(join(repo, "..", "list-empty-once"), "");
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), listRetryMs: 10 });
    expect(rs.map((r) => r.issue)).toEqual([1]);
    const log = (await Bun.file(join(repo, "..", "list.log")).text()).trim().split("\n");
    expect(log).toHaveLength(2);
  });

  test("re-lists once even when the first list is partial, merging both", async () => {
    const { repo } = await setup(issues);
    const root = join(repo, "..");
    await Bun.write(join(root, "list-partial-once"), JSON.stringify([{ number: 2, title: issues[1]![1], createdAt: issues[1]![2] }]));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), listRetryMs: 10 });
    expect(rs.map((r) => r.issue)).toEqual([1]);
    const log = (await Bun.file(join(root, "list.log")).text()).trim().split("\n");
    expect(log).toHaveLength(2);
  });
});


describe("blocked issues", () => {
  const issues: [number, string, string][] = [
    [1, "First", "2026-01-01T00:00:00Z"],
    [2, "Second", "2026-02-01T00:00:00Z"],
    [3, "Third", "2026-03-01T00:00:00Z"],
  ];
  const BLOCK = `<report>${JSON.stringify({ blocked_by: [{ title: "Need the thing", body: "Cannot proceed. Accept: thing exists." }] })}</report>`;
  // Issue 1's implementer says it is blocked; everyone else is fine.
  function blockingAgent(): Agent {
    const ok = fakeAgent();
    const blocked = fakeAgent(APPROVE, BLOCK);
    return {
      command(prompt, mode = "write") {
        return (/issue #1[:.]/.test(prompt) ? blocked : ok).command(prompt, mode);
      },
    };
  }

  test("files the blocker as discovered, relabels, comments, no push or PR, cleans up", async () => {
    const { repo, createLog } = await setup(issues);
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: blockingAgent() });
    expect(r.status).toBe("blocked");
    expect(r.blockedBy).toEqual({ number: 100, title: "Need the thing" });
    const log = await Bun.file(createLog).text();
    expect(log).toContain("--label\ndiscovered");
    expect(log).toMatch(/Blocks #1\.\n---/);
    const edits = await Bun.file(join(repo, "..", "edits.log")).text();
    expect(edits).toContain("label create bunker-blocked");
    expect(edits).toContain("issue edit 1 --remove-label bunker:queued --add-label bunker-blocked");
    expect(edits).toContain("issue comment 1 --body Blocked by #100: ` Need the thing `");
    expect((await $`git -C ${repo} ls-remote --heads origin`.text()).includes("feature/1")).toBe(false);
    expect((await $`git -C ${repo} branch --list ${"feature/1-*"}`.text()).trim()).toBe("");
    expect(await Bun.file(r.worktree).exists()).toBe(false);
  });

  test("a blocker naming an open issue reuses it: nothing new is filed", async () => {
    const { repo, createLog } = await setup(issues);
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "Existing work", body: "x", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker:queued" }] }));
    const report = `<report>${JSON.stringify({ blocked_by: [{ title: "Restated", issue: 50 }] })}</report>`;
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.status).toBe("blocked");
    expect(r.blockedBy).toEqual({ number: 50, title: "Existing work" });
    expect(await Bun.file(createLog).exists()).toBe(false);
    expect(await Bun.file(join(root, "edits.log")).text()).toContain("issue comment 1 --body Blocked by #50: ` Existing work `");
  });

  test("a blocker whose title matches an open issue is rejected as new and reuses that issue", async () => {
    const { repo, createLog } = await setup([...issues, [60, "Need the THING", "2026-04-01T00:00:00Z"]]);
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: blockingAgent() });
    expect(r.status).toBe("blocked");
    expect(r.blockedBy).toEqual({ number: 60, title: "Need the THING" });
    expect(await Bun.file(createLog).exists()).toBe(false);
  });

  test("a blocker naming a missing or closed issue is not trusted: falls back to filing", async () => {
    const { repo } = await setup(issues);
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "Done", state: "CLOSED", labels: [] }));
    const report = `<report>${JSON.stringify({ blocked_by: [{ title: "Need the thing", body: "b", issue: 50 }] })}</report>`;
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.blockedBy).toEqual({ number: 100, title: "Need the thing" });
  });

  test("an optional dependency is not a block: the prompt says so, and no blocked_by builds normally", async () => {
    const { repo } = await setup(issues);
    const prompts: string[] = [];
    const agent = fakeAgent();
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: { command(p, m = "write") { prompts.push(p); return agent.command(p, m); } } });
    expect(r.status).toBe("pr-opened");
    expect(prompts[0]).toContain("cannot be delivered at all");
    expect(prompts[0]).toContain("optional or secondary part");
    expect(prompts[0]).toContain("existing open issue");
  });

  test("unblocks once the issue it was blocked on (a reused one) closes", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "Existing work", body: "x", author: { login: "owner" }, state: "OPEN", labels: [] }));
    const report = `<report>${JSON.stringify({ blocked_by: [{ title: "Restated", issue: 50 }] })}</report>`;
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.status).toBe("blocked");
    // The comment bunker left names #50; it closes, and the watcher's resume pass requeues #1.
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Do it.", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker-blocked" }], comments: [{ authorAssociation: "OWNER", body: "Blocked by #50: ` Existing work `" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "Existing work", state: "CLOSED", labels: [] }));
    await Bun.write(join(root, "blocked-list.json"), JSON.stringify([{ number: 1, title: "First", createdAt: "2026-01-01T00:00:00Z" }]));
    const resumed = await resumeBlocked(repo, process.env as Record<string, string>);
    expect(resumed.map((q) => q.number)).toEqual([1]);
    expect(await Bun.file(join(root, "edits.log")).text()).toContain("issue edit 1 --remove-label bunker-blocked --add-label bunker:queued");
  });

  test("the old <blocked-by> tag is no longer a block", async () => {
    const { repo } = await setup(issues);
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: fakeAgent(APPROVE, '<blocked-by title="Need the thing">why</blocked-by>') });
    expect(r.status).toBe("pr-opened");
  });

  test("blocked doesn't use a --limit slot and doesn't stop the queue", async () => {
    const { repo } = await setup(issues, "ff");
    const rs = await runQueue({ cwd: repo, agent: blockingAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "blocked"], [2, "merged"]]);
  });

  test("skips an issue whose body or trusted comment says Blocked by / Depends on an open issue", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    const mk = (n: number, extra: object) => Bun.write(join(root, `issue-${n}.json`), JSON.stringify({ number: n, title: "t", body: "Do it.", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker:queued" }], ...extra }));
    await mk(1, { body: "blocked BY #50 please" });
    await mk(2, { comments: [{ authorAssociation: "OWNER", body: "Depends on #50" }] });
    await mk(50, {});
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[3, "merged"]]);
  });

  test("Blocked by in the body of an untrusted author's issue is ignored; in a read-only collaborator's comment too", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    const bin = join(root, "bin");
    const orig = await Bun.file(join(bin, "gh")).text();
    await Bun.write(join(bin, "gh"), orig.replace(/\*"\/permission"\*\) echo admin; exit 0;;/, '*"/permission"*) case "$*" in *mallory*|*triager*) echo read; exit 0;; esac; echo admin; exit 0;;'));
    const mk = (n: number, extra: object) => Bun.write(join(root, `issue-${n}.json`), JSON.stringify({ number: n, title: "t", body: "Do it.", state: "OPEN", labels: [{ name: "bunker:queued" }], author: { login: "owner" }, ...extra }));
    await mk(1, { body: "Blocked by #50", author: { login: "mallory" } });
    await mk(2, { comments: [{ author: { login: "triager" }, authorAssociation: "COLLABORATOR", body: "Depends on #50" }] });
    await mk(3, {});
    await mk(50, {});
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 3, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => r.issue)).toContain(1);
    expect(rs.map((r) => r.issue)).toContain(2);
  });

  test("a reference to a closed issue doesn't block", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "t", body: "Depends on #50", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker:queued" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "t", body: "", state: "CLOSED", stateReason: "COMPLETED", labels: [] }));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"]]);
  });

  test("a blocker closed as not planned no longer blocks", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "t", body: "Depends on #50", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker:queued" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "t", body: "", state: "CLOSED", stateReason: "NOT_PLANNED", labels: [] }));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"]]);
  });

  test("auto-resume: a bunker-blocked issue whose blockers closed goes back to bunker and is worked", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Do it.", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker-blocked" }], comments: [{ authorAssociation: "OWNER", body: "Blocked by #50: thing" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "thing", body: "", state: "CLOSED", stateReason: "COMPLETED", labels: [] }));
    await Bun.write(join(root, "blocked-list.json"), JSON.stringify([{ number: 1, title: "First", createdAt: "2026-01-01T00:00:00Z" }]));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"]]);
    const edits = await Bun.file(join(root, "edits.log")).text();
    expect(edits).toContain("issue edit 1 --remove-label bunker-blocked --add-label bunker:queued");
    expect(edits).toContain("issue comment 1 --body Unblocked: #50 is closed");
  });

  test("auto-resume queues the resumed issue even when the label-filtered list lags", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "list.json"), "[]");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Do it.", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker-blocked" }], comments: [{ authorAssociation: "OWNER", body: "Blocked by #50: thing" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "thing", body: "", state: "CLOSED", stateReason: "COMPLETED", labels: [] }));
    await Bun.write(join(root, "blocked-list.json"), JSON.stringify([{ number: 1, title: "First", createdAt: "2026-01-01T00:00:00Z" }]));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"]]);
  });

  test("auto-resume leaves an issue blocked while any blocker is open", async () => {
    const { repo } = await setup(issues);
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Depends on #50, blocked by #51", author: { login: "owner" }, state: "OPEN", labels: [{ name: "bunker-blocked" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, state: "CLOSED", stateReason: "COMPLETED", labels: [] }));
    await Bun.write(join(root, "issue-51.json"), JSON.stringify({ number: 51, author: { login: "owner" }, state: "OPEN", labels: [] }));
    await Bun.write(join(root, "blocked-list.json"), JSON.stringify([{ number: 1, title: "First", createdAt: "2026-01-01T00:00:00Z" }]));
    await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), listRetryMs: 10, limit: 1 });
    const edits = (await Bun.file(join(root, "edits.log")).exists()) ? await Bun.file(join(root, "edits.log")).text() : "";
    expect(edits).not.toMatch(/issue edit \d+ --(add|remove)-label (?!bunker:in-progress)/);
  });
});

describe("structured follow-ups", () => {
  test("verdict and report issues are filed with bodies intact; quoted example ignored", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    const verdict = `e.g. <verdict>{"approved":false,"issues":[{"title":"Quoted","body":"no"}]}</verdict>\n<verdict>{"approved":true,"issues":[{"title":"Rev found","body":"see \`rev.ts\` and \`x\`"}]}</verdict>`;
    const report = `<report>{"issues":[{"title":"Impl found","body":"use \`--flag\`"}]}</report>`;
    const r = await runIssue({ cwd: repo, issue: 7, sandbox: noSandbox(), agent: fakeAgent(verdict, report) });
    expect(r.status).toBe("pr-opened");
    // Both are medium: only the first is filed, the other is listed in the PR body.
    expect(r.filed.map((f) => f.title)).toEqual(["Impl found"]);
    const log = await Bun.file(createLog).text();
    expect(log).toContain("use `--flag`\n\nFound while working on #7.");
    expect(await Bun.file(join(repo, "..", "pr-body.txt")).text()).toContain("Rev found");
    expect(log).not.toContain("Quoted");
  });

  test("a structured blocked_by parks the issue", async () => {
    const { repo } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    const report = `<report>{"blocked_by":[{"title":"Need the thing","body":"Accept: \`thing\` exists."}]}</report>`;
    const r = await runIssue({ cwd: repo, issue: 7, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.status).toBe("blocked");
    expect(r.blockedBy?.title).toBe("Need the thing");
  });
});

describe("queue order: priority, bug, age", () => {
  type L = string[];
  // [number, createdAt, labels]; titles are derived.
  async function ordered(rows: [number, string, L][], extra: Record<number, object> = {}) {
    const env = await setup(rows.map(([n, at]) => [n, `T${n}`, at]), "ff");
    const root = join(env.repo, "..");
    const list = rows.map(([number, createdAt, labels]) => ({ number, title: `T${number}`, createdAt, labels: labels.map((name) => ({ name })) }));
    await Bun.write(join(root, "list.json"), JSON.stringify(list));
    for (const [n, , labels] of rows) {
      await Bun.write(join(root, `issue-${n}.json`), JSON.stringify({ number: n, title: `T${n}`, body: "Do it.", author: { login: "owner" }, state: "OPEN", labels: ["bunker:queued", ...labels].map((name) => ({ name })), ...extra[n] }));
    }
    return { ...env, root };
  }
  const run = (repo: string, more: object = {}) => runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10, listRetryMs: 10, limit: 10, ...more });

  test("high before medium before none before low", async () => {
    const { repo } = await ordered([
      [1, "2026-01-01T00:00:00Z", ["priority:low"]],
      [2, "2026-01-02T00:00:00Z", []],
      [3, "2026-01-03T00:00:00Z", ["priority:high"]],
      [4, "2026-01-04T00:00:00Z", ["priority:medium"]],
    ]);
    const rs = await run(repo);
    expect(rs.map((r) => r.issue)).toEqual([3, 4, 2, 1]);
  });

  test("bug before enhancement at equal priority, but priority wins over bug; oldest first as tiebreak", async () => {
    const { repo } = await ordered([
      [1, "2026-01-01T00:00:00Z", ["enhancement"]],
      [2, "2026-01-02T00:00:00Z", ["bug"]],
      [3, "2026-01-03T00:00:00Z", ["bug"]],
      [4, "2026-01-04T00:00:00Z", ["priority:high"]],
      [5, "2026-01-05T00:00:00Z", ["bug", "priority:low"]],
    ]);
    const rs = await run(repo);
    expect(rs.map((r) => r.issue)).toEqual([4, 2, 3, 1, 5]);
  });

  test("a blocked high-priority issue is skipped", async () => {
    const { repo, root } = await ordered(
      [
        [1, "2026-01-01T00:00:00Z", []],
        [2, "2026-01-02T00:00:00Z", ["priority:high"]],
      ],
      { 2: { body: "Blocked by #50" } },
    );
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "t", body: "", author: { login: "owner" }, state: "OPEN", labels: [] }));
    const rs = await run(repo);
    expect(rs.map((r) => r.issue)).toEqual([1]);
  });

  test("announces the order with the reason per issue, as an event and in the run log", async () => {
    const { repo } = await ordered([
      [131, "2026-01-01T00:00:00Z", []],
      [132, "2026-01-02T00:00:00Z", ["priority:low"]],
      [160, "2026-01-03T00:00:00Z", ["bug", "priority:high"]],
    ]);
    const notes: string[] = [];
    const rs = await run(repo, { onEvent: (e: { type: string; text?: string }) => e.type === "note" && notes.push(e.text ?? ""), limit: 1 });
    expect(notes[0]).toBe("queue: #160 (high, bug) · #131 · #132 (low)");
    expect(await Bun.file(rs[0]!.logPath!).text()).toContain("queue: #160 (high, bug) · #131 · #132 (low)");
  });

  test("creates the priority labels", async () => {
    const { repo, root } = await ordered([[1, "2026-01-01T00:00:00Z", []]]);
    await run(repo, { limit: 1 });
    const edits = await Bun.file(join(root, "edits.log")).text();
    expect(edits).toContain("label create priority:high --description bunker queue priority --color B60205");
    expect(edits).toContain("label create priority:medium");
    expect(edits).toContain("label create priority:low");
  });

  test("relist: an issue relabelled priority:high mid-pass runs next", async () => {
    const { repo, root } = await ordered([
      [1, "2026-01-01T00:00:00Z", []],
      [2, "2026-01-02T00:00:00Z", []],
      [3, "2026-01-03T00:00:00Z", []],
    ]);
    const inner = fakeAgent();
    const agent: Agent = {
      command(prompt, mode = "write") {
        const cmd = inner.command(prompt, mode);
        if (mode === "write" && /issue #1[:.]/.test(prompt)) {
          const list = join(root, "list.json");
          const edit = `sed -i 's/"number":3,\\("title":"T3","createdAt":"[^"]*"\\),"labels":\\[\\]/"number":3,\\1,"labels":[{"name":"priority:high"}]/' "${list}"`;
          return ["sh", "-c", `${edit}; ${cmd[2]}`];
        }
        return cmd;
      },
    };
    const rs = await runQueue({ cwd: repo, agent, sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10, listRetryMs: 10, limit: 10, relist: true });
    expect(rs.map((r) => r.issue)).toEqual([1, 3, 2]);
  });

  test("relist: labels the queue note '(re-ordered)' only when the relative order changed", async () => {
    const pass = async (promote: boolean) => {
      const { repo, root } = await ordered([
        [1, "2026-01-01T00:00:00Z", []],
        [2, "2026-01-02T00:00:00Z", []],
        [3, "2026-01-03T00:00:00Z", []],
      ]);
      const inner = fakeAgent();
      const agent: Agent = {
        command(prompt, mode = "write") {
          const cmd = inner.command(prompt, mode);
          if (promote && mode === "write" && /issue #1[:.]/.test(prompt)) {
            const edit = `sed -i 's/"number":3,\\("title":"T3","createdAt":"[^"]*"\\),"labels":\\[\\]/"number":3,\\1,"labels":[{"name":"priority:high"}]/' "${join(root, "list.json")}"`;
            return ["sh", "-c", `${edit}; ${cmd[2]}`];
          }
          return cmd;
        },
      };
      const notes: string[] = [];
      await runQueue({ cwd: repo, agent, sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10, listRetryMs: 10, limit: 10, relist: true, onEvent: (e: { type: string; text?: string }) => e.type === "note" && notes.push(e.text ?? "") });
      return notes.filter((n) => n.includes("re-ordered"));
    };
    expect(await pass(false)).toEqual([]);
    expect((await pass(true)).length).toBe(1);
  });

  test("without relist the order is fixed at the start of the pass", async () => {
    const { repo, root } = await ordered([
      [1, "2026-01-01T00:00:00Z", []],
      [2, "2026-01-02T00:00:00Z", []],
      [3, "2026-01-03T00:00:00Z", []],
    ]);
    const inner = fakeAgent();
    const agent: Agent = {
      command(prompt, mode = "write") {
        const cmd = inner.command(prompt, mode);
        if (mode === "write" && /issue #1[:.]/.test(prompt)) {
          const edit = `sed -i 's/"number":3,\\("title":"T3","createdAt":"[^"]*"\\),"labels":\\[\\]/"number":3,\\1,"labels":[{"name":"priority:high"}]/' "${join(root, "list.json")}"`;
          return ["sh", "-c", `${edit}; ${cmd[2]}`];
        }
        return cmd;
      },
    };
    const rs = await runQueue({ cwd: repo, agent, sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10, listRetryMs: 10, limit: 10 });
    expect(rs.map((r) => r.issue)).toEqual([1, 2, 3]);
  });
});

describe("agent-filed issues", () => {
  test("never carry a priority label; a bug follow-up gets `bug`", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    const report = '<report>{"issues":[{"title":"Crash on empty","body":"boom","bug":true,"severity":"high"},{"title":"Nice to have","body":"later"}]}</report>';
    const r = await runIssue({ cwd: repo, issue: 7, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    expect(r.filed.length).toBe(1);
    const log = await Bun.file(createLog).text();
    expect(log).not.toContain("priority");
    expect(log).toMatch(/^bug$/m);
    expect(log).toContain("discovered");
  });
});

describe("runQueue() label-adder check", () => {
  const ghWith = async (env: Env, adderRole: string | null) => {
    const bin = join(env.repo, "..", "bin");
    const orig = await Bun.file(join(bin, "gh")).text();
    const gate = adderRole === null ? 'echo "HTTP 403" >&2; exit 1' : `echo ${adderRole}; exit 0`;
    await Bun.write(join(bin, "gh"), orig.replace(/^if \[ "\$1" = "api" \].*$/m, `if [ "$1" = "api" ]; then case "$*" in *"/rules/branches/"*) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test"}]}}]'; exit 0;; *graphql*|*renamed*) exit 0;; *created_at*) echo 2020-01-01T00:00:00Z; exit 0;; *"/events"*) echo tess; exit 0;; *"/permission"*) ${gate};; esac; fi`));
  };
  const run = (env: Env, allowLabelers?: string[]) =>
    runQueue({ agent: fakeAgent(), sandbox: noSandbox(), cwd: env.repo, listRetryMs: 0, ...(allowLabelers ? { allowLabelers } : {}) });

  test("a label added by a write user is skipped, removed, and commented on", async () => {
    const env = await setup([[1, "T", "2024-01-01T00:00:00Z"]]);
    await ghWith(env, "write");
    expect(await run(env)).toEqual([]);
    const edits = await Bun.file(join(env.repo, "..", "edits.log")).text();
    expect(edits).toContain("issue edit 1 --remove-label bunker:queued");
    expect(edits).toContain("issue comment 1 --body @tess only maintainers can queue bunker work");
  });

  test("a failed permission lookup skips without touching the issue", async () => {
    const env = await setup([[1, "T", "2024-01-01T00:00:00Z"]]);
    await ghWith(env, null);
    expect(await run(env)).toEqual([]);
    expect(await Bun.file(join(env.repo, "..", "edits.log")).text()).not.toContain("issue edit");
  });

  test("allowLabelers lets the adder through", async () => {
    const env = await setup([[1, "T", "2024-01-01T00:00:00Z"]]);
    await ghWith(env, "write");
    expect((await run(env, ["tess"])).map((e) => e.issue)).toEqual([1]);
  });

  test("a maintainer's label runs", async () => {
    const env = await setup([[1, "T", "2024-01-01T00:00:00Z"]]);
    await ghWith(env, "maintain");
    expect((await run(env)).map((e) => e.issue)).toEqual([1]);
  });
});

describe("sanitising filed issues", () => {
  const NASTY = "Fixes #12 @someone ghp_abcdefghijklmnop";
  const check = (log: string) => {
    expect(log).not.toMatch(/(fixes|closes)\s+#1[23]/i);
    expect(log).not.toContain("@someone");
    expect(log).not.toContain("ghp_");
    expect(log).toContain("[REDACTED]");
  };
  test("follow-up issues", async () => {
    const { repo, createLog } = await setup([[1, "First", "2026-01-01T00:00:00Z"]]);
    const report = `<report>${JSON.stringify({ issues: [{ title: NASTY, body: `Closes #13 ${NASTY}`, severity: "high" }] })}</report>`;
    await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    check(await Bun.file(createLog).text());
  });
  test("blocker issues", async () => {
    const { repo, createLog } = await setup([[1, "First", "2026-01-01T00:00:00Z"]]);
    const report = `<report>${JSON.stringify({ blocked_by: [{ title: NASTY, body: `Closes #13 ${NASTY}` }] })}</report>`;
    await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: fakeAgent(APPROVE, report) });
    check(await Bun.file(createLog).text());
  });
});
