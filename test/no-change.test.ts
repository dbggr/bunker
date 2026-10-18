import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent } from "../src/index.ts";
import { runIssue } from "../src/pipeline/issue.ts";
import { extractOutput, noChangeOutput } from "../src/core/structured.ts";

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
  for (const k of TOKEN_VARS) {
    if (origTokens[k] === undefined) delete process.env[k];
    else process.env[k] = origTokens[k];
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const APPROVE = '<verdict>{"approved":true,"required_changes":[]}</verdict>';
const REJECT = '<verdict>{"approved":false,"required_changes":["the claim does not hold"]}</verdict>';
const nc = (v: object) => `<no-change>${JSON.stringify(v)}</no-change>`;
const QUEUED = [{ name: "bunker:queued" }];

interface World {
  repo: string;
  sha: string;
  calls: () => Promise<string[]>;
}

/** A repo with src/a.ts (3 lines) on a local origin, and a fake gh that records what it is asked to change. */
async function setup(issue: object = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "bunker-nochange-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await Bun.write(join(repo, "src/a.ts"), "one\ntwo\nthree\n");
  await $`git -C ${repo} add . && git -C ${repo} commit -q -m "fix: the thing"`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await $`git -C ${repo} push -q -u origin main`;
  const sha = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  await mkdir(bin);
  const view = { number: 7, title: "bug: broken", body: "It is broken.", state: "OPEN", labels: QUEUED, author: { login: "owner" }, comments: [], ...issue };
  await Bun.write(join(root, "issue.json"), JSON.stringify(view));
  const calls = join(root, "calls.log");
  await Bun.write(calls, "");
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
case "$*" in
  "issue view 5 "*|"pr view 12 "*|"issue view 12 "*) echo '{"number":1}'; exit 0;;
  "issue view 404 "*|"pr view 404 "*) exit 1;;
  "issue view 7 "*) cat "${root}/issue.json"; exit 0;;
  "api repos/{owner}/{repo}/issues/7"*) echo OWNER; exit 0;;
  "repo view"*) echo https://github.com/o/r; exit 0;;
  "label create"*) exit 0;;
  "issue close"*|"issue comment"*|"issue edit"*) echo "$*" | tr "\\n" " " >> "${calls}"; echo >> "${calls}"; exit 0;;
esac
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { repo, sha, calls: async () => (await Bun.file(calls).text()).split("\n").filter(Boolean) };
}

/** Implementer answers with `impl[i]` in round i (committing a file when `commit`); the reviewer answers with `rev[i]`. */
function agent(impl: string[], rev: string[], prompts: string[] = [], commit = false): Agent {
  let w = 0;
  let r = 0;
  return {
    command(prompt, mode = "write") {
      if (mode === "write") {
        prompts.push(prompt);
        const out = impl[Math.min(w++, impl.length - 1)]!;
        return ["sh", "-c", `${commit ? 'echo x > f.txt && git add . && git commit -qm "feat: x" && ' : ""}printf '%s' "$OUT"`.replace('"$OUT"', `'${out.replaceAll("'", "'\\''")}'`)];
      }
      prompts.push(`REVIEW:${prompt}`);
      return ["sh", "-c", `printf '%s' '${rev[Math.min(r++, rev.length - 1)]!}'`];
    },
  };
}

const run = (w: World, a: Agent, extra: object = {}) => runIssue({ issue: 7, cwd: w.repo, agent: a, sandbox: noSandbox(), maxRounds: 2, ...extra });

describe("<no-change> parsing", () => {
  test("accepts the four verdicts and rejects the rest", () => {
    const ok = extractOutput(nc({ verdict: "fixed", reason: "done", evidence: ["src/a.ts:1"] }), noChangeOutput);
    expect(ok.ok).toBe(true);
    for (const bad of [{ verdict: "valid", reason: "x", evidence: [] }, { verdict: "fixed", reason: "", evidence: ["a:1"] }, { verdict: "fixed", reason: "x", evidence: [] }, { verdict: "duplicate", reason: "x", evidence: [] }, { verdict: "cannot-reproduce", reason: "x", evidence: [3] }]) {
      expect(extractOutput(nc(bad), noChangeOutput).ok).toBe(false);
    }
    expect(extractOutput(nc({ verdict: "cannot-reproduce", reason: "x", evidence: [] }), noChangeOutput).ok).toBe(true);
  });
});

describe("runIssue() with a <no-change> verdict", () => {
  const cases = [
    { verdict: "fixed", reason: "completed", extra: {} },
    { verdict: "as-designed", reason: "not planned", extra: {} },
    { verdict: "cannot-reproduce", reason: "not planned", extra: {} },
    { verdict: "duplicate", reason: "duplicate", extra: { duplicate_of: 5 } },
  ];
  for (const c of cases) {
    test(`${c.verdict} closes as ${c.reason} with an explained comment`, async () => {
      const w = await setup();
      const claim = nc({ verdict: c.verdict, reason: "It works on main @alice. Fixes #3", evidence: ["src/a.ts:2", w.sha.slice(0, 8), "#12"], ...c.extra });
      const r = await run(w, agent([claim], [APPROVE]));
      expect(r.status).toBe("no-change");
      expect(r.noChange?.verdict).toBe(c.verdict as never);
      const calls = await w.calls();
      const close = calls.find((l) => l.startsWith("issue close 7"))!;
      expect(close).toBeDefined();
      expect(close).toContain(c.reason === "duplicate" ? "--reason duplicate" : `--reason ${c.reason}`);
      if (c.verdict === "duplicate") expect(close).toContain("--duplicate-of 5");
      expect(close).toContain("https://github.com/o/r/blob/");
      expect(close).toContain("#L2");
      expect(close).toContain(`/commit/${w.sha.slice(0, 8)}`);
      expect(close).toContain("It works on main");
      expect(close).not.toContain("@alice"); // defused
      expect(close).toContain("bunker:queued");
      expect(close).toContain("reopen");
      expect(calls.some((l) => l.startsWith("issue edit 7") && l.includes("--remove-label bunker:queued"))).toBe(true);
      expect(calls.some((l) => l.includes("--remove-label bunker:in-progress"))).toBe(true);
    });
  }

  test("the reviewer sees the issue, the verdict and the evidence", async () => {
    const w = await setup();
    const prompts: string[] = [];
    await run(w, agent([nc({ verdict: "fixed", reason: "gone", evidence: ["src/a.ts:1"] })], [APPROVE], prompts));
    const rev = prompts.find((p) => p.startsWith("REVIEW:"))!;
    expect(rev).toContain("It is broken.");
    expect(rev).toContain("src/a.ts:1");
    expect(rev).toContain("gone");
  });

  test("a reviewer who disagrees sends the implementer back to work; the round limit applies", async () => {
    const w = await setup();
    const prompts: string[] = [];
    const r = await run(w, agent([nc({ verdict: "fixed", reason: "gone", evidence: ["src/a.ts:1"] }), "I did the work"], [REJECT], prompts, false));
    expect(r.status).toBe("rejected");
    expect(r.review?.rounds).toHaveLength(2);
    expect(prompts.filter((p) => !p.startsWith("REVIEW:"))[1]).toContain("the claim does not hold");
    expect((await w.calls()).some((l) => l.startsWith("issue close"))).toBe(false);
  });

  test("a verdict with commits fails the run", async () => {
    const w = await setup();
    const r = await run(w, agent([nc({ verdict: "fixed", reason: "gone", evidence: ["src/a.ts:1"] })], [APPROVE], [], true));
    expect(r.status).toBe("failed");
    expect(r.error).toContain("commit");
    expect((await w.calls()).some((l) => l.startsWith("issue close"))).toBe(false);
  });

  for (const [name, evidence] of [
    ["a line past the end of the file", ["src/a.ts:99"]],
    ["a file that does not exist", ["src/none.ts:1"]],
    ["an unknown commit", ["deadbeef1234"]],
    ["a PR that does not exist", ["#404"]],
    ["free text", ["trust me"]],
  ] as const) {
    test(`evidence naming ${name} is rejected`, async () => {
      const w = await setup();
      const r = await run(w, agent([nc({ verdict: "fixed", reason: "gone", evidence: [...evidence] })], [APPROVE]), { maxRounds: 1 });
      expect(r.status).toBe("rejected");
      expect(r.review?.rounds[0]?.feedback).toContain(evidence[0]!);
      expect((await w.calls()).some((l) => l.startsWith("issue close"))).toBe(false);
    });
  }

  test("an issue that lost bunker:queued is not closed", async () => {
    const w = await setup({ labels: [] });
    const r = await run(w, agent([nc({ verdict: "fixed", reason: "gone", evidence: ["src/a.ts:1"] })], [APPROVE]));
    expect(r.status).toBe("failed");
    expect((await w.calls()).some((l) => l.startsWith("issue close"))).toBe(false);
  });

  describe("after a reopen", () => {
    const earlier = (evidence: string[]) => ({
      body: `<!-- bunker-no-change ${JSON.stringify({ verdict: "fixed", reason: "it was fixed earlier", evidence }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")} -->\n**bunker: no change needed.**`,
      author: { login: "bot" },
    });

    test("the prompt carries the earlier verdict and the same grounds are not accepted again", async () => {
      const w = await setup({ comments: [earlier(["src/a.ts:1"])] });
      const prompts: string[] = [];
      const claim = nc({ verdict: "fixed", reason: "still fixed", evidence: ["src/a.ts:1"] });
      const r = await run(w, agent([claim], [APPROVE], prompts), { maxRounds: 1 });
      expect(prompts[0]).toContain("it was fixed earlier");
      expect(prompts[0]).toContain("reopened");
      expect(r.status).toBe("rejected");
      expect(r.review?.rounds[0]?.feedback).toContain("new evidence");
      expect((await w.calls()).some((l) => l.startsWith("issue close"))).toBe(false);
    });

    test("new evidence is accepted", async () => {
      const w = await setup({ comments: [earlier(["src/a.ts:1"])] });
      const r = await run(w, agent([nc({ verdict: "fixed", reason: "also here", evidence: ["src/a.ts:1", "src/a.ts:3"] })], [APPROVE]));
      expect(r.status).toBe("no-change");
    });
  });
});
