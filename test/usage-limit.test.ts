import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, noSandbox, type Agent } from "../src/index.ts";
import { runIssue } from "../src/pipeline/issue.ts";
import { runWatch } from "../src/cli/commands/watch.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
const realHome = process.env.HOME;
beforeEach(() => {
  delete process.env.BUNKER_GH_TOKEN;
});
afterEach(async () => {
  process.env.PATH = origPath;
  process.env.HOME = realHome;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const VERDICT = '<verdict>{"approved":true,"required_changes":[]}</verdict>';
const result = (o: object) => `echo '${JSON.stringify({ type: "result", total_cost_usd: 0.1, duration_ms: 5, ...o })}'`;

describe("claudeCode().usageLimit", () => {
  const agent = claudeCode({ json: true });
  test("recognises a usage-limit result and its reset time", () => {
    const at = Date.UTC(2030, 0, 1, 12);
    expect(agent.usageLimit?.(JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|" + at / 1000 }))).toEqual({ resetAt: at });
    expect(agent.usageLimit?.(JSON.stringify({ type: "result", subtype: "error_usage_limit", is_error: true, result: "stop", resets_at: new Date(at).toISOString() }))).toEqual({ resetAt: at });
    expect(agent.usageLimit?.(JSON.stringify({ type: "result", is_error: true, result: "5-hour limit reached" }))).toEqual({});
  });
  test("treats a transient API rate limit (429) as an ordinary error, not a usage-limit pause", () => {
    for (const result of ["API Error: 429 rate_limit_error: Rate limit exceeded", "Rate limit reached, retry shortly", "rate limit"]) {
      expect(agent.usageLimit?.(JSON.stringify({ type: "result", is_error: true, result }))).toBeUndefined();
    }
    expect(agent.usageLimit?.(JSON.stringify({ type: "result", subtype: "error_rate_limit", is_error: true, result: "429" }))).toBeUndefined();
  });
  test("ignores ordinary results and errors", () => {
    expect(agent.usageLimit?.(JSON.stringify({ type: "result", result: "I fixed the usage limit bug" }))).toBeUndefined();
    expect(agent.usageLimit?.(JSON.stringify({ type: "result", is_error: true, result: "boom" }))).toBeUndefined();
    expect(agent.usageLimit?.("plain")).toBeUndefined();
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bunker-limit-"));
  dirs.push(root);
  const home = join(root, "home");
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await $`mkdir -p ${home} ${bin}`;
  process.env.HOME = home;
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} commit -q --allow-empty -m init`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await $`git -C ${repo} push -q -u origin main`;
  const issue = { number: 1, title: "First", body: "Do it.", state: "OPEN", labels: [{ name: "bunker" }] };
  await Bun.write(join(root, "issue.json"), JSON.stringify(issue));
  await Bun.write(join(root, "q.json"), JSON.stringify({ number: 1, title: "First", createdAt: "2026-01-01T00:00:00Z" }));
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${root}/gh.log"
if [ "$1" = "api" ]; then case "$*" in *"/rules/branches/"*) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test"}]}}]'; exit 0;; *graphql*|*renamed*) exit 0;; *created_at*) echo 2020-01-01T00:00:00Z; exit 0;; *"/events"*) echo owner; exit 0;; *"/permission"*) echo admin; exit 0;; esac; fi
if [ "$1 $2" = "issue list" ]; then printf '['; [ -f "${root}/q.json" ] && cat "${root}/q.json"; printf ']'; exit 0; fi
if [ "$1 $2" = "issue view" ]; then cat "${root}/issue.json"; exit 0; fi
if [ "$1 $2" = "issue edit" ]; then rm -f "${root}/q.json"; exit 0; fi
if [ "$1 $2" = "issue comment" ] || [ "$1 $2" = "label create" ]; then exit 0; fi
if [ "$1 $2" = "pr list" ]; then echo '[]'; exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/1"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then echo '{"state":"MERGED","mergeCommit":{"oid":"abc"}}'; exit 0; fi
if [ "$1 $2" = "pr merge" ]; then rm -f "${root}/q.json"; git --git-dir="${origin}" update-ref refs/heads/main "refs/heads/$(git rev-parse --abbrev-ref HEAD)"; exit 0; fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { root, repo };
}

/** Fake claude: the first implementer call hits the usage limit (leaving a commit-less session); resumed calls finish. */
function limitedAgent(root: string, resetAt?: number): Agent {
  const base = claudeCode({ json: true });
  const calls = join(root, "calls.log");
  return {
    ...base,
    command(prompt, mode = "write", o) {
      if (mode === "review") return ["sh", "-c", result({ result: VERDICT, session_id: "rev" })];
      const limited = !existsSync(join(root, "limited"));
      const script = [
        `echo "write resume=${o?.resume ?? "none"}" >> ${calls}`,
        `P=$HOME/.claude/projects/$(pwd | tr -c 'a-zA-Z0-9\\n' -)`,
        `mkdir -p "$P"; echo '{}' > "$P/sess-1.jsonl"`,
        limited
          ? `touch ${root}/limited; ${result({ is_error: true, subtype: "success", result: "Claude AI usage limit reached", session_id: "sess-1", ...(resetAt ? { resets_at: new Date(resetAt).toISOString() } : {}) })}; exit 1`
          : `echo hi > f.txt && git add . && git commit -qm "feat: impl"; ${result({ result: "done", session_id: "sess-1" })}`,
      ].join("\n");
      return ["sh", "-c", script];
    },
  };
}

const callsOf = async (root: string) => (await Bun.file(join(root, "calls.log")).text()).trim().split("\n");
const base = { sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10 };

describe("usage limit", () => {
  test("runIssue pauses (keeping work and the label) and a re-run resumes the same session", async () => {
    const { root, repo } = await setup();
    const a = limitedAgent(root, Date.now() + 3_600_000);
    const first = await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(first.status).toBe("paused-usage-limit");
    expect(first.pause?.sessionId).toBe("sess-1");
    expect(first.pause?.resetAt).toBeGreaterThan(Date.now());
    expect(existsSync(first.worktree)).toBe(true);
    expect((await $`git -C ${repo} branch --list ${first.branch}`.text()).trim()).not.toBe("");
    expect(await Bun.file(join(root, "gh.log")).text()).not.toContain("bunker-failed");

    const second = await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(second.status).toBe("merged");
    expect(await callsOf(root)).toEqual(["write resume=none", "write resume=sess-1"]);
    expect(existsSync(join(repo, ".bunker", "paused", "1.json"))).toBe(false);
  });

  // #316: agent commits stay in the review worktree until the run ends, so a resumed run's prompt never sees them.
  /** Implementer commits `plant` (plus a file); the first review call hits the usage limit, later ones approve. */
  function reviewerLimitedAgent(root: string, plant: string): Agent {
    const base = claudeCode({ json: true });
    return {
      ...base,
      command(prompt, mode = "write") {
        if (mode === "review") {
          const limited = !existsSync(join(root, "limited"));
          return ["sh", "-c", limited ? `touch ${root}/limited; ${result({ is_error: true, result: "Claude AI usage limit reached", session_id: "rev-1", resets_at: new Date(Date.now() + 3_600_000).toISOString() })}; exit 1` : result({ result: VERDICT, session_id: "rev-2" })];
        }
        return ["sh", "-c", `${plant}echo hi > f.txt && git add -A && git commit -qm "feat: impl"; ${result({ result: "done", session_id: "sess-1" })}`];
      },
    };
  }

  test("a resumed run ignores a prompt template the agent committed before the pause", async () => {
    const { root, repo } = await setup();
    const pwned = join(root, "pwned");
    const plant = `mkdir -p .bunker/prompts && printf '%s\\n' '!\`touch ${pwned}\`' '{{ISSUE}}' > .bunker/prompts/issue.md; `;
    const a = reviewerLimitedAgent(root, plant);
    const first = await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(first.status).toBe("paused-usage-limit");
    expect(existsSync(join(first.worktree, ".bunker", "prompts", "issue.md"))).toBe(false); // not merged back while paused
    await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(existsSync(pwned)).toBe(false);
  });

  test("a default-branch template's command runs against the default branch, not the agent's worktree", async () => {
    const { root, repo } = await setup();
    await $`mkdir -p ${repo}/.bunker/prompts`;
    await Bun.write(join(repo, ".bunker", "prompts", "issue.md"), "ctx: !`sh ctx.sh`\n{{ISSUE}}\n");
    await Bun.write(join(repo, "ctx.sh"), "echo trusted\n");
    await $`git -C ${repo} add -A && git -C ${repo} commit -qm "chore: template" && git -C ${repo} push -q origin main`;
    const pwned = join(root, "pwned");
    const a = reviewerLimitedAgent(root, `printf 'touch ${pwned}\\necho evil\\n' > ctx.sh; `);
    const first = await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(first.status).toBe("paused-usage-limit");
    expect(await Bun.file(join(first.worktree, "ctx.sh")).text()).toBe("echo trusted\n");
    await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(existsSync(pwned)).toBe(false);
  });

  test("resuming after a pause replaces a diverged origin branch instead of failing the push", async () => {
    const { root, repo } = await setup();
    const a = limitedAgent(root, Date.now() + 3_600_000);
    const first = await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(first.status).toBe("paused-usage-limit");
    const other = join(root, "other");
    await $`git clone -q ${join(root, "origin.git")} ${other}`;
    await $`git -C ${other} checkout -q -b ${first.branch}`;
    await Bun.write(join(other, "diverged.txt"), "x");
    await $`git -C ${other} add . && git -C ${other} -c user.name=t -c user.email=t@t commit -q -m "feat: diverged"`;
    await $`git -C ${other} push -q origin ${first.branch}`;
    const old = (await $`git -C ${other} rev-parse HEAD`.text()).trim();

    const second = await runIssue({ ...base, cwd: repo, issue: 1, agent: a });
    expect(second.status).toBe("merged");
    const tags = (await $`git -C ${repo} tag --list ${"bunker/stale/1-remote-*"}`.text()).trim().split("\n").filter(Boolean);
    expect(tags).toHaveLength(1);
    expect((await $`git -C ${repo} rev-parse ${`${tags[0]}^{commit}`}`.text()).trim()).toBe(old);
  });

  test("watch sleeps until the reset time, resumes the same session, never labels bunker-failed", async () => {
    const { root, repo } = await setup();
    const resetAt = Date.now() + 1500;
    const lines: string[] = [];
    const ctl = new AbortController();
    const s = await runWatch({
      ...base, cwd: repo, agent: limitedAgent(root, resetAt), intervalMs: 20_000, listRetryMs: 5, signal: ctl.signal,
      log: (l) => { lines.push(l); if (/pass 2 /.test(l)) ctl.abort(); },
    });
    expect(Date.now()).toBeGreaterThanOrEqual(resetAt);
    expect(s.merged).toBe(1);
    expect(s.failed).toBe(0);
    expect(lines.join("\n")).toMatch(/usage limit.*#1.*resum/is);
    expect(await callsOf(root)).toEqual(["write resume=none", "write resume=sess-1"]);
    expect(await Bun.file(join(root, "gh.log")).text()).not.toContain("bunker-failed");
  });

  test("watch with no reset time waits --interval", async () => {
    const { root, repo } = await setup();
    const ctl = new AbortController();
    const t0 = Date.now();
    const s = await runWatch({
      ...base, cwd: repo, agent: limitedAgent(root), intervalMs: 800, listRetryMs: 5, signal: ctl.signal,
      log: (l) => { if (/pass 2 /.test(l)) ctl.abort(); },
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(s.merged).toBe(1);
    expect(s.failed).toBe(0);
  });
});

describe("bunker --issue CLI", () => {
  test("exits 3 with a re-run hint on a usage limit; re-running resumes the same session", async () => {
    const { root, repo } = await setup();
    const bin = join(root, "bin");
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const out = (o: object) => JSON.stringify({ type: "result", total_cost_usd: 0.1, duration_ms: 5, ...o });
    await Bun.write(
      join(bin, "claude"),
      `#!/bin/sh
case "$2" in "You are reviewing"*) echo '${out({ result: VERDICT, session_id: "rev" })}'; exit 0;; esac
resume=none; for a in "$@"; do [ "$prev" = "--resume" ] && resume=$a; prev=$a; done
echo "write resume=$resume" >> "${root}/calls.log"
P=$HOME/.claude/projects/$(pwd | tr -c 'a-zA-Z0-9\\n' -)
mkdir -p "$P"; echo '{}' > "$P/sess-1.jsonl"
if [ ! -f "${root}/limited" ]; then
  touch "${root}/limited"
  echo '${out({ is_error: true, result: "Claude AI usage limit reached", session_id: "sess-1", resets_at: resetAt })}'; exit 1
fi
echo hi > f.txt && git add . && git commit -qm "feat: impl"
echo '${out({ result: "done", session_id: "sess-1" })}'
`,
    );
    await chmod(join(bin, "claude"), 0o755);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const run = async () => {
      const proc = Bun.spawn(["bun", cli, "--issue", "1", "--no-sandbox", "--verify", "true"], { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { stdout, code };
    };
    const first = await run();
    expect(first.code).toBe(3);
    expect(first.stdout).toContain("[paused-usage-limit]");
    expect(first.stdout).toContain(`re-run after ${resetAt} to resume`);
    expect(await Bun.file(join(root, "gh.log")).text()).not.toContain("bunker-failed");

    const second = await run();
    expect(second.code).toBe(0);
    expect(await callsOf(root)).toEqual(["write resume=none", "write resume=sess-1"]);
  });
});

describe("bunker --review and plain run CLI on a usage limit", () => {
  async function limitedClaude() {
    const { root, repo } = await setup();
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const out = (o: object) => JSON.stringify({ type: "result", total_cost_usd: 0.1, duration_ms: 5, ...o });
    await Bun.write(
      join(root, "bin", "claude"),
      `#!/bin/sh
echo '${out({ is_error: true, result: "Claude AI usage limit reached", session_id: "sess-1", resets_at: resetAt })}'; exit 1
`,
    );
    await chmod(join(root, "bin", "claude"), 0o755);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", cli, ...args, "--no-sandbox"], { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    return { repo, resetAt, run };
  }

  test("--review exits 3 with a re-run hint and leaves no worktree behind", async () => {
    const { repo, resetAt, run } = await limitedClaude();
    const r = await run("--review", "do it");
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("[paused-usage-limit]");
    expect(r.stdout).toContain(`re-run after ${resetAt}`);
    expect((await $`git -C ${repo} worktree list --porcelain`.text()).match(/^worktree /gm)?.length).toBe(1);
  });

  test("plain run exits 3 with a re-run hint instead of a generic failure", async () => {
    const { resetAt, run } = await limitedClaude();
    const r = await run("do it");
    expect(r.code).toBe(3);
    expect(r.stdout + r.stderr).toContain("paused on the Claude usage limit");
    expect(r.stdout + r.stderr).toContain(`re-run after ${resetAt}`);
  });
});
