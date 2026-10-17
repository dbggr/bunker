import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent, type Sandbox } from "../src/index.ts";
import { parseBlockedBy, parseIssueBlocks, runIssue, runQueue } from "../src/issue.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = origPath;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const APPROVE = "<review>APPROVE</review>";

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
    await Bun.write(join(root, `issue-${number}.json`), JSON.stringify({ number, title, body: "Do it.", state: "OPEN", labels: [{ name: "bunker" }] }));
  }
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
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
  for a in "$@"; do printf '%s\\n' "$a"; done >> "${createLog}"
  echo "---" >> "${createLog}"
  echo "https://github.com/o/r/issues/100"
  exit 0
fi
if [ "$1 $2" = "issue edit" ] || [ "$1 $2" = "issue comment" ] || [ "$1 $2" = "label create" ]; then
  echo "$*" >> "${root}/edits.log"
  if [ "$1 $2" = "issue edit" ]; then
    case "$*" in
      *"--add-label bunker-blocked"*) sed -i 's/"name":"bunker"/"name":"bunker-blocked"/' "${root}/issue-$3.json" ;;
      *"--add-label bunker"*) sed -i 's/"name":"bunker-blocked"/"name":"bunker"/' "${root}/issue-$3.json" ;;
    esac
  fi
  exit 0
fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/$(git rev-parse --abbrev-ref HEAD | tr '/' '-')"; exit 0; fi
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

describe("code in filed blocks", () => {
  test("a real block keeps inline code and fenced snippets in title and body", () => {
    const body = "fix `src/issue.ts` now\n```ts\nconst a = 1;\n```\nend";
    expect(parseIssueBlocks(`<issue title="Use \`--flag\`">${body}</issue>`)).toEqual([{ title: "Use `--flag`", body }]);
    expect(parseBlockedBy('<blocked-by title="T">see `x.ts`</blocked-by>')).toEqual({ title: "T", body: "see `x.ts`" });
  });
  test("a real block between inline code spans keeps those spans", () => {
    expect(parseIssueBlocks('use `a` <issue title="Real">has `b` inside</issue> and `c`')).toEqual([{ title: "Real", body: "has `b` inside" }]);
  });
  test("a block quoted in backticks is still ignored", () => {
    expect(parseIssueBlocks('say `<issue title="Q">x</issue>` ok')).toEqual([]);
  });
});

describe("parseIssueBlocks()", () => {
  test("extracts blocks, dedupes by title", () => {
    const out = 'x <issue title="A">body a</issue>\n<issue title="B">line1\nline2</issue> <issue title="A">again</issue>';
    expect(parseIssueBlocks(out)).toEqual([
      { title: "A", body: "body a" },
      { title: "B", body: "line1\nline2" },
    ]);
  });

  test("ignores quoted examples and placeholder titles, keeps real blocks", () => {
    const b = (t: string) => `<issue title="${t}">body</issue>`;
    expect(parseIssueBlocks(`see \`${b("Quoted")}\``)).toEqual([]);
    expect(parseIssueBlocks("```\n" + b("Fenced") + "\n```")).toEqual([]);
    expect(parseIssueBlocks("~~~xml\n" + b("Tilde") + "\n~~~")).toEqual([]);
    expect(parseIssueBlocks(`${b("…")} ${b("...")} ${b("  ")} ${b("short title")} ${b("Short Title")}`)).toEqual([]);
    expect(parseIssueBlocks(`\`x\` then ${b("Real")}`)).toEqual([{ title: "Real", body: "body" }]);
    expect(parseIssueBlocks(`a stray \` tick\n${b("Real")}\nanother \` tick`)).toEqual([{ title: "Real", body: "body" }]);
    // Only an equal-length backtick run closes a span.
    expect(parseIssueBlocks(`a \`\`b\`c ${b("Real")} d\`\` e`)).toEqual([]);
    expect(parseIssueBlocks(`\`a\`\` ${b("Real")}`)).toEqual([{ title: "Real", body: "body" }]);
  });
});

describe("filing discovered issues", () => {
  test("implementer and reviewer blocks become discovered issues, deduped, never bunker", async () => {
    const { repo, createLog } = await setup([[7, "Add feature", "2026-01-01T00:00:00Z"]]);
    const prompts: string[] = [];
    const r = await runIssue({
      cwd: repo, issue: 7, sandbox: noSandbox(),
      agent: fakeAgent(`${APPROVE} <issue title="Rev found">rb</issue> <issue title="Dup">second</issue>`, '<issue title="Dup">first</issue>', prompts),
    });
    expect(r.status).toBe("pr-opened");
    expect(r.filed).toEqual([{ number: 100, title: "Dup" }, { number: 100, title: "Rev found" }]);
    const log = await Bun.file(createLog).text();
    expect(log.match(/--label\ndiscovered/g)?.length).toBe(2);
    expect(log).not.toMatch(/bunker/);
    expect(log).toContain("first\n\nFound while working on #7.");
    expect(prompts.some((p) => p.startsWith("REVIEW:") && p.includes("<issue title="))).toBe(true);
    expect(prompts[0]).toContain("<issue title=");
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
    const rs = await runQueue({ cwd: repo, agent: fakeAgent("nope"), sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "rejected"]]);
  });

  test("skips listed issues that are closed or no longer labelled when re-checked", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "x", state: "CLOSED", labels: [{ name: "bunker" }] }));
    await Bun.write(join(root, "issue-2.json"), JSON.stringify({ number: 2, title: "Second", body: "x", state: "OPEN", labels: [] }));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[3, "merged"]]);
  });

  test("skips a candidate whose re-check fails instead of aborting the queue", async () => {
    const { repo } = await setup(issues, "ff");
    await Bun.write(join(repo, "..", "view-fail-1"), "");
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 2, ciPollMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[2, "merged"], [3, "merged"]]);
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
    for (const raw of ["null", "[]", '{"state":"OPEN"}', '{"state":"OPEN","labels":"bunker"}', '{"state":"OPEN","labels":[null]}',
      '{"state":"OPEN","labels":[{"name":"bunker"}],"comments":"x","body":5}', '{"state":"OPEN","labels":[{"name":"bunker"}],"comments":[null]}',
      '{"state":"OPEN","labels":[{"name":"bunker"}],"comments":[{"body":5,"authorAssociation":"OWNER"}]}']) {
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

describe("parseBlockedBy()", () => {
  const b = (t: string) => `<blocked-by title="${t}">why</blocked-by>`;
  test("extracts the first real block", () => {
    expect(parseBlockedBy(`x ${b("Need A")} ${b("Need B")}`)).toEqual({ title: "Need A", body: "why" });
    expect(parseBlockedBy("no block")).toBeUndefined();
  });
  test("ignores code spans, fences and placeholders", () => {
    expect(parseBlockedBy(`see \`${b("Quoted")}\``)).toBeUndefined();
    expect(parseBlockedBy("```\n" + b("Fenced") + "\n```")).toBeUndefined();
    expect(parseBlockedBy(`${b("…")} ${b("short title")}`)).toBeUndefined();
  });
});

describe("blocked issues", () => {
  const issues: [number, string, string][] = [
    [1, "First", "2026-01-01T00:00:00Z"],
    [2, "Second", "2026-02-01T00:00:00Z"],
    [3, "Third", "2026-03-01T00:00:00Z"],
  ];
  const BLOCK = '<blocked-by title="Need the thing">Cannot proceed. Accept: thing exists.</blocked-by>';
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
    expect(edits).toContain("issue edit 1 --remove-label bunker --add-label bunker-blocked");
    expect(edits).toContain("issue comment 1 --body Blocked by #100: Need the thing");
    expect((await $`git -C ${repo} ls-remote --heads origin`.text()).includes("feature/1")).toBe(false);
    expect((await $`git -C ${repo} branch --list ${"feature/1-*"}`.text()).trim()).toBe("");
    expect(await Bun.file(r.worktree).exists()).toBe(false);
  });

  test("a quoted <blocked-by> is not a block", async () => {
    const { repo } = await setup(issues);
    const r = await runIssue({ cwd: repo, issue: 1, sandbox: noSandbox(), agent: fakeAgent(APPROVE, `\`${BLOCK}\``) });
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
    const mk = (n: number, extra: object) => Bun.write(join(root, `issue-${n}.json`), JSON.stringify({ number: n, title: "t", body: "Do it.", state: "OPEN", labels: [{ name: "bunker" }], ...extra }));
    await mk(1, { body: "blocked BY #50 please" });
    await mk(2, { comments: [{ authorAssociation: "OWNER", body: "Depends on #50" }] });
    await mk(50, {});
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[3, "merged"]]);
  });

  test("a reference to a closed issue doesn't block", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "t", body: "Depends on #50", state: "OPEN", labels: [{ name: "bunker" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "t", body: "", state: "CLOSED", stateReason: "COMPLETED", labels: [] }));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"]]);
  });

  test("a blocker closed as not planned no longer blocks", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "t", body: "Depends on #50", state: "OPEN", labels: [{ name: "bunker" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "t", body: "", state: "CLOSED", stateReason: "NOT_PLANNED", labels: [] }));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"]]);
  });

  test("auto-resume: a bunker-blocked issue whose blockers closed goes back to bunker and is worked", async () => {
    const { repo } = await setup(issues, "ff");
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Do it.", state: "OPEN", labels: [{ name: "bunker-blocked" }], comments: [{ authorAssociation: "OWNER", body: "Blocked by #50: thing" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, title: "thing", body: "", state: "CLOSED", stateReason: "COMPLETED", labels: [] }));
    await Bun.write(join(root, "blocked-list.json"), JSON.stringify([{ number: 1, title: "First", createdAt: "2026-01-01T00:00:00Z" }]));
    const rs = await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), verify: "true", merge: true, limit: 1, ciPollMs: 10, listRetryMs: 10 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"]]);
    const edits = await Bun.file(join(root, "edits.log")).text();
    expect(edits).toContain("issue edit 1 --remove-label bunker-blocked --add-label bunker");
    expect(edits).toContain("issue comment 1 --body Unblocked: #50 is closed");
  });

  test("auto-resume leaves an issue blocked while any blocker is open", async () => {
    const { repo } = await setup(issues);
    const root = join(repo, "..");
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Depends on #50, blocked by #51", state: "OPEN", labels: [{ name: "bunker-blocked" }] }));
    await Bun.write(join(root, "issue-50.json"), JSON.stringify({ number: 50, state: "CLOSED", stateReason: "COMPLETED", labels: [] }));
    await Bun.write(join(root, "issue-51.json"), JSON.stringify({ number: 51, state: "OPEN", labels: [] }));
    await Bun.write(join(root, "blocked-list.json"), JSON.stringify([{ number: 1, title: "First", createdAt: "2026-01-01T00:00:00Z" }]));
    await runQueue({ cwd: repo, agent: fakeAgent(), sandbox: noSandbox(), listRetryMs: 10, limit: 1 });
    expect(await Bun.file(join(root, "edits.log")).exists()).toBe(false);
  });
});
