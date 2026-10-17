import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, noSandbox, review, run, type Agent, type Sandbox } from "../src/index.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const realHome = process.env.HOME;
let home: string;
let log: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bunker-home-"));
  dirs.push(home);
  log = join(home, "calls.log");
  process.env.HOME = home;
});
afterEach(async () => {
  process.env.HOME = realHome;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-resume-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

const APPROVE = "<review>APPROVE</review>";
const REJ = '<verdict>{"approved":false,"required_changes":["fix"]}</verdict>';

/**
 * A fake `claude`: records "<mode> resume=<id|none> present=<yes|no>" per call, writes a session
 * file under $HOME/.claude/projects, and prints a stream-json result carrying the session id.
 * `failResume` makes any resumed call exit 1.
 */
function fakeClaude(opts: { reviewer?: (n: number) => string; failResume?: boolean } = {}): Agent {
  let calls = 0;
  const base = claudeCode({ json: true });
  return {
    ...base,
    command(prompt, mode = "write", o) {
      const id = `sess-${++calls}`;
      const resume = o?.resume;
      const review = mode === "review";
      const text = review ? (opts.reviewer?.(calls) ?? APPROVE) : "done";
      const script = [
        `P=$HOME/.claude/projects/$(pwd | tr -c 'a-zA-Z0-9\\n' -)`,
        `mkdir -p "$P"`,
        resume ? `if [ -f "$P/${resume}.jsonl" ]; then H=yes; else H=no; fi` : `H=no`,
        `echo "${mode} resume=${resume ?? "none"} present=$H" >> ${log}`,
        opts.failResume && resume ? "exit 1" : "true",
        `echo '{"type":"system","subtype":"init","session_id":"${id}"}' > "$P/${id}.jsonl"`,
        review ? "true" : `N=$(git rev-list --count HEAD); echo $N > f$N.txt && git add . && git commit -qm "impl $N"`,
        `echo '{"type":"result","result":${JSON.stringify(text)},"session_id":"${id}","total_cost_usd":0.1,"duration_ms":5}'`,
      ].join("\n");
      return ["sh", "-c", script];
    },
  };
}

/** A host sandbox that deletes the agent's session files before every call. */
function forgetful(): Sandbox {
  const inner = noSandbox();
  return {
    get projectsDir() {
      return inner.projectsDir;
    },
    exec: async (cmd, ctx) => {
      // A resumed call (its script names the session file) must find what was restored for it.
      if (!cmd.join(" ").includes("sess-")) await rm(join(home, ".claude"), { recursive: true, force: true });
      return inner.exec(cmd, ctx);
    },
  };
}

const calls = async () => (existsSync(log) ? (await Bun.file(log).text()).trim().split("\n") : []);

describe("claudeCode() resume", () => {
  test("adds --resume <id> only when asked", () => {
    const a = claudeCode({ json: true });
    expect(a.command("x", "write")).not.toContain("--resume");
    const cmd = a.command("x", "write", { resume: "abc" });
    expect(cmd.slice(cmd.indexOf("--resume"), cmd.indexOf("--resume") + 2)).toEqual(["--resume", "abc"]);
  });

  test("sessionId reads session_id from the stream", () => {
    const out = '{"type":"system","session_id":"s1"}\n{"type":"result","result":"x","session_id":"s1"}\n';
    expect(claudeCode({ json: true }).sessionId?.(out)).toBe("s1");
    expect(claudeCode({ json: true }).sessionId?.("plain")).toBeUndefined();
  });
});

describe("review() resume", () => {
  test("round 2 implementer resumes round 1's session, restored into the sandbox; reviewer stays fresh", async () => {
    const repo = await makeRepo();
    const sessionsDir = join(home, "sessions");
    const r = await review({
      cwd: repo, prompt: "do it", agent: fakeClaude({ reviewer: (n) => (n === 2 ? REJ : APPROVE) }), sandbox: forgetful(), sessionsDir,
    });
    expect(r.status).toBe("approved");
    // The sandbox forgets its sessions between calls, so only the restore from sessionsDir can satisfy the resume.
    expect(await calls()).toEqual(["write resume=none present=no", "review resume=none present=no", "write resume=sess-1 present=yes", "review resume=none present=no"]);
    expect(r.rounds.map((x) => x.sessionId)).toEqual(["sess-1", "sess-3"]);
    expect((await readdir(sessionsDir)).sort()).toContain("implementer-1.jsonl");
    expect(await readdir(sessionsDir)).toContain("reviewer-1.jsonl");
  });

  test("resume failure falls back to a fresh session", async () => {
    const repo = await makeRepo();
    const prompts: string[] = [];
    const agent = fakeClaude({ reviewer: (n) => (n === 2 ? REJ : APPROVE), failResume: true });
    const inner = agent.command;
    agent.command = (p, m, o) => (m === "write" && prompts.push(p), inner(p, m, o));
    const notes: string[] = [];
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox(), sessionsDir: join(home, "s"), onEvent: (e) => e.type === "note" && notes.push(e.text ?? "") });
    expect(r.status).toBe("approved");
    const c = await calls();
    expect(c).toContain("write resume=sess-1 present=yes");
    expect(c.filter((l) => l.startsWith("write")).at(-1)).toBe("write resume=none present=no");
    expect(notes.join("\n")).toMatch(/resume/);
    // The fresh retry carries the whole task plus the feedback.
    expect(prompts.at(-1)).toContain("do it");
    expect(prompts.at(-1)).toContain("fix");
  });

  test("resume: false never passes --resume", async () => {
    const repo = await makeRepo();
    const r = await review({ cwd: repo, prompt: "p", agent: fakeClaude({ reviewer: (n) => (n === 2 ? REJ : APPROVE) }), sandbox: noSandbox(), resume: false, sessionsDir: join(home, "s") });
    expect(r.status).toBe("approved");
    expect((await calls()).every((l) => l.includes("resume=none"))).toBe(true);
  });
});

describe("run() iterations resume", () => {
  test("iteration 2 resumes iteration 1; resume: false does not", async () => {
    const repo = await makeRepo();
    const a = await run({ cwd: repo, prompt: "p", agent: fakeClaude(), sandbox: noSandbox(), maxIterations: 2, sessionsDir: join(home, "s1") });
    expect(a.iterations.map((i) => i.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(await calls()).toEqual(["write resume=none present=no", "write resume=sess-1 present=yes"]);
    await rm(log);
    const repo2 = await makeRepo();
    await run({ cwd: repo2, prompt: "p", agent: fakeClaude(), sandbox: noSandbox(), maxIterations: 2, resume: false, sessionsDir: join(home, "s2") });
    expect((await calls()).every((l) => l.includes("resume=none"))).toBe(true);
  });
});
