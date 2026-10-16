import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent } from "../src/index.ts";
import { parseIssueBlocks, runIssue, runQueue } from "../src/issue.ts";

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
    await Bun.write(join(root, `issue-${number}.json`), JSON.stringify({ number, title, body: "Do it.", state: "OPEN", labels: [] }));
  }
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "issue list" ]; then echo "$*" >> "${root}/list.log"; cat "${root}/list.json"; exit 0; fi
if [ "$1 $2" = "issue view" ]; then cat "${root}/issue-$3.json"; exit 0; fi
if [ "$1 $2" = "issue create" ]; then
  shift 2
  for a in "$@"; do printf '%s\\n' "$a"; done >> "${createLog}"
  echo "---" >> "${createLog}"
  echo "https://github.com/o/r/issues/100"
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
});
