import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent } from "../src/index.ts";
import { runAudit } from "../src/audit.ts";

const dirs: string[] = [];
const origPath = process.env.PATH;
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "BUNKER_GH_TOKEN"];
const origTokens = Object.fromEntries(TOKEN_VARS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of TOKEN_VARS) delete process.env[k];
});
afterEach(async () => {
  process.env.PATH = origPath;
  for (const k of TOKEN_VARS) {
    if (origTokens[k] === undefined) delete process.env[k];
    else process.env[k] = origTokens[k];
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Repo with a local bare origin and a fake `gh` that lists `existing` open issues and logs creates.
async function setup(existing: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "bunker-audit-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} commit -q --allow-empty -m init`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await $`git -C ${repo} push -q -u origin main`;
  await $`mkdir ${bin}`;
  await Bun.write(join(root, "open.json"), JSON.stringify(existing.map((title, i) => ({ number: i + 1, title }))));
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "issue list" ]; then echo "$*" >> "${root}/list.log"; cat "${root}/open.json"; exit 0; fi
if [ "$1 $2" = "issue create" ]; then
  shift 2
  for a in "$@"; do printf '%s\\n' "$a"; done >> "${root}/create.log"
  n=$(( $(grep -c '^--title$' "${root}/create.log") + 100 ))
  echo "https://github.com/o/r/issues/$n"
  exit 0
fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { repo, createLog: join(root, "create.log") };
}

const block = (t: string) => `<issue title="${t}">Do ${t}.\n- [ ] done</issue>`;

// Prints `output`, records the prompt/mode and its worktree, and makes a commit (which must not survive).
function fakeAgent(output: string, seen: { prompt?: string; mode?: string; cwd?: string } = {}): Agent {
  return {
    command(prompt, mode) {
      seen.prompt = prompt;
      seen.mode = mode;
      return ["sh", "-c", `pwd > "${process.env.AUDIT_PWD}"; cat <<'EOF'\n${output}\nEOF`];
    },
  };
}

describe("runAudit()", () => {
  test("files blocks as discovered only, capped, skipping open duplicates; worktree removed", async () => {
    const { repo, createLog } = await setup(["Existing thing"]);
    const pwdFile = join(repo, "..", "pwd");
    process.env.AUDIT_PWD = pwdFile;
    const seen: { prompt?: string; mode?: string } = {};
    const out = ["noise", block("existing THING"), block("A"), block("B"), block("C")].join("\n");
    const r = await runAudit({ cwd: repo, agent: fakeAgent(out, seen), sandbox: noSandbox(), maxIssues: 2, focus: "error handling" });
    expect(r.filed).toEqual([
      { number: 101, title: "A" },
      { number: 102, title: "B" },
    ]);
    expect(r.skipped).toEqual(["existing THING"]);
    const args = (await Bun.file(createLog).text()).split("\n");
    expect(args.filter((a) => a === "--label")).toHaveLength(2);
    expect(args.filter((a) => a === "discovered")).toHaveLength(2);
    expect(args).not.toContain("bunker");
    expect(seen.mode).toBe("review");
    expect(seen.prompt).toContain("at most 2");
    expect(seen.prompt).toContain("error handling");
    const wt = (await Bun.file(pwdFile).text()).trim();
    expect(existsSync(wt)).toBe(false);
    expect((await $`git -C ${repo} worktree list`.text()).trim().split("\n")).toHaveLength(1);
  });

  test("returns the usage the agent's parse reports", async () => {
    const { repo } = await setup();
    process.env.AUDIT_PWD = join(repo, "..", "pwd");
    const agent: Agent = {
      ...fakeAgent(block("A")),
      parse: (stdout) => ({ text: stdout, usage: { costUsd: 0.42, durationMs: 1500 } }),
    };
    const r = await runAudit({ cwd: repo, agent, sandbox: noSandbox() });
    expect(r.usage).toEqual({ costUsd: 0.42, durationMs: 1500 });
    expect(r.filed).toHaveLength(1);
  });

  test("usage is absent when the agent reports none", async () => {
    const { repo } = await setup();
    process.env.AUDIT_PWD = join(repo, "..", "pwd");
    const r = await runAudit({ cwd: repo, agent: fakeAgent(block("A")), sandbox: noSandbox() });
    expect(r.usage).toBeUndefined();
  });

  test("default cap is 5", async () => {
    const { repo } = await setup();
    process.env.AUDIT_PWD = join(repo, "..", "pwd");
    const out = "ABCDEFG".split("").map(block).join("\n");
    const r = await runAudit({ cwd: repo, agent: fakeAgent(out), sandbox: noSandbox() });
    expect(r.filed).toHaveLength(5);
  });
});
