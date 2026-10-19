import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent, type BunkerEvent } from "../src/index.ts";
import { runAudit } from "../src/pipeline/audit.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "BUNKER_GH_TOKEN"];
const origTokens = Object.fromEntries(TOKEN_VARS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of TOKEN_VARS) delete process.env[k];
});
afterEach(async () => {
  process.env.PATH = origPath;
  delete process.env.AUDIT_PWD;
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
  process.env.AUDIT_PWD = join(root, "pwd"); // fakeAgent writes its cwd here
  return { repo, createLog: join(root, "create.log") };
}

const issue = (t: string, severity = "medium") => ({ title: t, body: `Do ${t}.\n- [ ] done`, severity });
const block = (t: string) => `<audit>${JSON.stringify({ issues: [issue(t)] })}</audit>`;
const blocks = (...ts: string[]) => `<audit>${JSON.stringify({ issues: ts.map((t) => issue(t)) })}</audit>`;

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

describe("runAudit() severity", () => {
  test("files only high/medium, highest first, within --max-issues; low is reported as not filed", async () => {
    const { repo, createLog } = await setup();
    const out = `<audit>${JSON.stringify({ issues: [issue("Nit", "low"), issue("Med one", "medium"), issue("Sec hole", "high"), issue("Med two", "medium")] })}</audit>`;
    const r = await runAudit({ cwd: repo, agent: fakeAgent(out), sandbox: noSandbox(), maxIssues: 2 });
    expect(r.filed.map((f) => f.title)).toEqual(["Sec hole", "Med one"]);
    expect(r.notFiled.map((f) => f.title)).toEqual(["Med two", "Nit"]);
    const log = await Bun.file(createLog).text();
    expect(log).toContain("severity:high");
    expect(log).toContain("severity:medium");
    expect(log).not.toMatch(/priority:|bunker$/m);
  });
});

describe("runAudit() timeouts", () => {
  const hang = (cmd: string): Agent => ({ command: () => ["sh", "-c", cmd] });

  test("an audit agent with no output is killed after the idle timeout", async () => {
    const { repo, createLog } = await setup();
    const t0 = Date.now();
    await expect(runAudit({ cwd: repo, agent: hang("sleep 30"), sandbox: noSandbox(), idleTimeoutMs: 300 })).rejects.toThrow(/idle timeout/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(existsSync(createLog)).toBe(false);
  });

  test("a hung setup is killed after the step timeout", async () => {
    const { repo } = await setup();
    await expect(runAudit({ cwd: repo, agent: hang("true"), sandbox: noSandbox(), setup: "sleep 30", stepTimeoutMs: 300 })).rejects.toThrow(/step timeout/);
  });

  test("an agent that prints its audit but lingers is killed and still counts", async () => {
    const { repo } = await setup();
    const out = `<audit>{"issues": []}</audit>`;
    const r = await runAudit({ cwd: repo, agent: hang(`echo '${out}'; echo '{"type":"result","result":"ok"}'; sleep 30`), sandbox: noSandbox(), completionTimeoutMs: 300 });
    expect(r.filed).toEqual([]);
  });
});

describe("runAudit()", () => {
  test("files blocks as discovered only, capped, skipping open duplicates; worktree removed", async () => {
    const { repo, createLog } = await setup(["Existing thing"]);
    const pwdFile = join(repo, "..", "pwd");
    process.env.AUDIT_PWD = pwdFile;
    const seen: { prompt?: string; mode?: string } = {};
    const out = `noise <issue title="Quoted">example</issue>\n${blocks("existing THING", "A", "B", "C")}`;
    const r = await runAudit({ cwd: repo, agent: fakeAgent(out, seen), sandbox: noSandbox(), maxIssues: 2, focus: "error handling" });
    expect(r.filed).toEqual([
      { number: 101, title: "A" },
      { number: 102, title: "B" },
    ]);
    expect(r.skipped).toEqual(["existing THING"]);
    const args = (await Bun.file(createLog).text()).split("\n");
    expect(args.filter((a) => a === "--label")).toHaveLength(4);
    expect(args.filter((a) => a === "discovered")).toHaveLength(2);
    expect(args).not.toContain("bunker");
    expect(seen.mode).toBe("review");
    expect(seen.prompt).toContain("at most 2");
    expect(seen.prompt).toContain("error handling");
    const wt = (await Bun.file(pwdFile).text()).trim();
    expect(existsSync(wt)).toBe(false);
    expect((await $`git -C ${repo} worktree list`.text()).trim().split("\n")).toHaveLength(1);
  });

  test("skips a title another audit filed while this one was running", async () => {
    const { repo, createLog } = await setup();
    const openFile = join(repo, "..", "open.json");
    const agent: Agent = {
      command() {
        // Another audit files "Racing" while the agent works.
        const open = JSON.stringify([{ number: 7, title: "Racing" }]);
        return ["sh", "-c", `printf '%s' '${open}' > "${openFile}"; cat <<'EOF'\n${blocks("racing", "Other")}\nEOF`];
      },
    };
    const r = await runAudit({ cwd: repo, agent, sandbox: noSandbox() });
    expect(r.skipped).toEqual(["racing"]);
    expect(r.filed).toEqual([{ number: 101, title: "Other" }]);
    expect((await Bun.file(createLog).text()).split("\n")).not.toContain("racing");
  });

  test("tells the agent which issues are already open", async () => {
    const { repo } = await setup(["Subprocess timeouts missing"]);
    const seen: { prompt?: string } = {};
    await runAudit({ cwd: repo, agent: fakeAgent(blocks(), seen), sandbox: noSandbox() });
    expect(seen.prompt).toContain("Subprocess timeouts missing");
    expect(seen.prompt).toMatch(/already open/i);
  });

  test("audits origin's default branch via a private ref, not the shared FETCH_HEAD", async () => {
    const { repo } = await setup();
    await runAudit({ cwd: repo, agent: fakeAgent(block("A")), sandbox: noSandbox() });
    expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);
    expect((await $`git -C ${repo} for-each-ref refs/bunker`.text()).trim()).toBe("");
  });

  test("returns the usage the agent's parse reports", async () => {
    const { repo } = await setup();
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
    const r = await runAudit({ cwd: repo, agent: fakeAgent(block("A")), sandbox: noSandbox() });
    expect(r.usage).toBeUndefined();
  });

  test("default cap is 5", async () => {
    const { repo } = await setup();
    const out = blocks(..."ABCDEFG".split(""));
    const r = await runAudit({ cwd: repo, agent: fakeAgent(out), sandbox: noSandbox() });
    expect(r.filed).toHaveLength(5);
  });

  test("quoted <issue> blocks and earlier <audit> examples are never filed", async () => {
    const { repo, createLog } = await setup();
    const out = `e.g. <issue title="X">y</issue> or ${block("Quoted")}\n${block("Real")}`;
    const r = await runAudit({ cwd: repo, agent: fakeAgent(out), sandbox: noSandbox() });
    expect(r.filed.map((f) => f.title)).toEqual(["Real"]);
    expect(await Bun.file(createLog).text()).not.toContain("Quoted");
  });

  test("re-asks after invalid output, then files", async () => {
    const { repo } = await setup();
    const prompts: string[] = [];
    const agent: Agent = {
      command(prompt) {
        prompts.push(prompt);
        const out = prompts.length === 1 ? "<audit>not json</audit>" : block("A");
        return ["sh", "-c", `cat <<'EOF'\n${out}\nEOF`];
      },
    };
    const r = await runAudit({ cwd: repo, agent, sandbox: noSandbox() });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("invalid JSON");
    expect(r.filed.map((f) => f.title)).toEqual(["A"]);
  });

  test("throws and files nothing when output stays invalid after the retries", async () => {
    const { repo, createLog } = await setup();
    let calls = 0;
    const agent: Agent = {
      command() {
        calls++;
        return ["sh", "-c", "echo no block here"];
      },
    };
    await expect(runAudit({ cwd: repo, agent, sandbox: noSandbox(), maxRetries: 1 })).rejects.toThrow(/bad output after 1 retr/);
    expect(calls).toBe(2);
    expect(existsSync(createLog)).toBe(false);
  });
});

describe("runAudit() events", () => {
  test("publishes the audit stage, then done", async () => {
    const { repo } = await setup();
    const events: BunkerEvent[] = [];
    await runAudit({ cwd: repo, agent: fakeAgent(block("A")), sandbox: noSandbox(), onEvent: (e) => events.push(e) });
    const stages = events.filter((e) => e.type === "stage");
    expect(stages.map((e) => e.name)).toEqual(["setup", "audit", "filing", "done"]);
    expect(stages[1]!.role).toBe("auditor");
  });

  test("publishes failed when the audit throws", async () => {
    const { repo } = await setup();
    const events: BunkerEvent[] = [];
    const bad: Agent = { command: () => ["sh", "-c", "exit 3"] };
    await expect(runAudit({ cwd: repo, agent: bad, sandbox: noSandbox(), onEvent: (e) => events.push(e) })).rejects.toThrow();
    expect(events.filter((e) => e.type === "stage").map((e) => e.name)).toEqual(["setup", "audit", "failed"]);
  });
});

describe("sanitising filed issues", () => {
  test("title and body are neutralised and redacted", async () => {
    const { repo, createLog } = await setup();
    const out = `<audit>${JSON.stringify({ issues: [{ title: "Fixes #12 @someone", body: "Closes #13 cc @other ghp_abcdefghijklmnop", severity: "high" }] })}</audit>`;
    await runAudit({ cwd: repo, agent: fakeAgent(out), sandbox: noSandbox() });
    const log = await Bun.file(createLog).text();
    expect(log).not.toMatch(/(fixes|closes)\s+#1[23]/i);
    expect(log).not.toContain("@someone");
    expect(log).not.toContain("@other");
    expect(log).not.toContain("ghp_");
    expect(log).toContain("[REDACTED]");
  });
});

describe("runAudit() copy", () => {
  test("copies the configured gitignored files into the worktree before setup", async () => {
    const { repo } = await setup();
    await Bun.write(join(repo, ".bunker/config.toml"), 'copy = ["backend/.env"]\n');
    await Bun.write(join(repo, ".gitignore"), ".env\n");
    await $`git -C ${repo} add -A`;
    await $`git -C ${repo} commit -q -m cfg`;
    await $`git -C ${repo} push -q origin main`;
    await Bun.write(join(repo, "backend/.env"), "A=1\n");
    const r = await runAudit({ cwd: repo, agent: fakeAgent(blocks()), sandbox: noSandbox(), setup: "test -f backend/.env" });
    expect(r.filed).toEqual([]);
  });
});

describe("runAudit() hub events", () => {
  test("emits tagged stages, a titled meta, each filed issue and the cost", async () => {
    const { repo } = await setup();
    const events: BunkerEvent[] = [];
    await runAudit({ cwd: repo, agent: fakeAgent(blocks("A", "B")), sandbox: noSandbox(), focus: "error handling", onEvent: (e) => events.push(e) });
    expect(events.every((e) => e.audit === true && e.issue === undefined)).toBe(true);
    expect(events.filter((e) => e.type === "stage").map((e) => e.name)).toEqual(["setup", "audit", "filing", "done"]);
    expect(events.find((e) => e.type === "meta" && e.title)?.title).toBe("Audit: error handling");
    const filed = events.filter((e) => e.type === "filed").map((e) => e.filed);
    expect(filed.map((f) => [f!.number, f!.title])).toEqual([[101, "A"], [102, "B"]]);
    expect(filed[0]!.url).toContain("/issues/101");
  });

  test("a failing audit ends on a failed stage", async () => {
    const { repo } = await setup();
    const events: BunkerEvent[] = [];
    await expect(runAudit({ cwd: repo, agent: fakeAgent("no block"), sandbox: noSandbox(), maxRetries: 0, onEvent: (e) => events.push(e) })).rejects.toThrow();
    expect(events.filter((e) => e.type === "stage").at(-1)?.name).toBe("failed");
  });
});
