import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent, type Sandbox } from "../src/index.ts";
import { parseDuration, runWatch } from "../src/watch.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = origPath;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const APPROVE = "<review>APPROVE</review>";

interface FakeOpts {
  /** Issue titles whose implementer run fails. */
  failing?: string[];
  /** Cost reported per agent run. */
  cost?: number;
  /** Seconds the implementer takes. */
  slow?: number;
  prompts?: string[];
  /** Issue titles whose implementer reports being blocked. */
  blocked?: string[];
}

function fakeAgent({ failing = [], cost, slow = 0, prompts = [], blocked = [] }: FakeOpts = {}): Agent {
  return {
    command(prompt, mode = "write") {
      if (mode !== "write") return ["sh", "-c", `echo '${APPROVE}'`];
      prompts.push(prompt);
      if (blocked.some((t) => prompt.includes(`Title: ${t}`))) return ["sh", "-c", `echo '<blocked-by title="Need the thing">Cannot proceed.</blocked-by>'`];
      if (failing.some((t) => prompt.includes(`Title: ${t}`))) return ["sh", "-c", "echo boom >&2; exit 1"];
      return ["sh", "-c", `sleep ${slow}; echo hi > f-$(date +%s%N).txt && git add . && git commit -qm "feat: impl"`];
    },
    ...(cost === undefined ? {} : { parse: (stdout: string) => ({ text: stdout, usage: { costUsd: cost, durationMs: 1 } }) }),
  };
}

async function setup(issues: [number, string, string][]) {
  const root = await mkdtemp(join(tmpdir(), "bunker-watch-"));
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
  await $`mkdir -p ${bin} ${root}/q`;
  for (const [number, title, createdAt] of issues) {
    await Bun.write(join(root, "q", `${number}.json`), JSON.stringify({ number, title, createdAt }));
    await Bun.write(join(root, `issue-${number}.json`), JSON.stringify({ number, title, body: "Do it.", state: "OPEN", labels: [{ name: "bunker" }] }));
  }
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${root}/gh.log"
if [ "$1" = "api" ]; then case "$*" in *"/events"*) echo owner; exit 0;; *"/permission"*) echo admin; exit 0;; esac; fi
if [ "$1 $2" = "issue list" ]; then
  printf '['; sep=''
  hide=0; case "$*" in *"--label bunker --state"*) [ -f "${root}/hide-2" ] && hide=$(cat "${root}/hide-2");; esac
  [ "$hide" -gt 0 ] && echo $((hide - 1)) > "${root}/hide-2"
  for f in "${root}"/q/*.json; do [ -f "$f" ] || continue; [ "$hide" -gt 0 ] && [ "$f" = "${root}/q/2.json" ] && continue; printf '%s' "$sep"; cat "$f"; sep=','; done
  printf ']'; exit 0
fi
if [ "$1 $2" = "issue view" ]; then cat "${root}/issue-$3.json"; exit 0; fi
if [ "$1 $2" = "issue edit" ] && [ -f "${root}/edit-fails" ]; then echo "network down" >&2; exit 1; fi
if [ "$1 $2" = "issue edit" ]; then rm -f "${root}/q/$3.json"; exit 0; fi
if [ "$1 $2" = "issue comment" ]; then shift 3; echo "COMMENT: $*" >> "${root}/comments.log"; exit 0; fi
if [ "$1 $2" = "label create" ]; then exit 0; fi
if [ "$1 $2" = "issue create" ]; then echo "https://github.com/o/r/issues/100"; exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/$(git rev-parse --abbrev-ref HEAD | tr '/' '-')"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then echo '{"state":"MERGED","mergeCommit":{"oid":"abc"}}'; exit 0; fi
if [ "$1 $2" = "pr merge" ]; then rm -f "${root}/q/$(git rev-parse --abbrev-ref HEAD | sed 's|^[a-z]*/||; s|-.*||').json"; git --git-dir="${origin}" update-ref refs/heads/main "refs/heads/$(git rev-parse --abbrev-ref HEAD)"; exit 0; fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  await Bun.write(join(bin, "notify-send"), `#!/bin/sh\nshift\necho "$*" >> "${root}/notify.log"\n`);
  await chmod(join(bin, "notify-send"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { repo, root };
}

const three: [number, string, string][] = [
  [1, "First", "2026-01-01T00:00:00Z"],
  [2, "Second", "2026-02-01T00:00:00Z"],
  [3, "Third", "2026-03-01T00:00:00Z"],
];

const base = { sandbox: noSandbox(), verify: "true", intervalMs: 10, listRetryMs: 5, ciPollMs: 10 };

describe("parseDuration()", () => {
  test("parses hours, minutes and combinations", () => {
    expect(parseDuration("5h")).toBe(5 * 3_600_000);
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("2h30m")).toBe(150 * 60_000);
  });
  test("rejects anything else", () => {
    for (const bad of ["", "5", "h", "5x", "0m", "0h0m", "-1h", "1.5h", "30m2h", "5h 30m", "abc"]) expect(parseDuration(bad)).toBeUndefined();
  });
});

describe("runWatch() --audit-every", () => {
  const auditor = (calls: string[]): Agent => ({
    command(prompt) {
      calls.push(prompt);
      return ["sh", "-c", "echo '<audit>{\"issues\": []}</audit>'"];
    },
  });
  const run = async (repo: string, calls: string[], passes: number) => {
    const ctl = new AbortController();
    return runWatch({
      ...base, cwd: repo, agent: fakeAgent(), auditor: auditor(calls), auditEveryDays: 30, signal: ctl.signal,
      log: (l) => { if (new RegExp(`pass ${passes} `).test(l)) ctl.abort(); },
    });
  };

  test("runs the audit once per period and records it in .bunker/watch-state.json", async () => {
    const { repo } = await setup(three.slice(0, 1));
    const calls: string[] = [];
    await run(repo, calls, 3);
    expect(calls).toHaveLength(1);
    const state = JSON.parse(await Bun.file(join(repo, ".bunker", "watch-state.json")).text());
    expect(Date.now() - state.lastAuditAt).toBeLessThan(60_000);
    // A second watch within the period does not audit again.
    await run(repo, calls, 1);
    expect(calls).toHaveLength(1);
  });

  test("audits again once the period has passed", async () => {
    const { repo } = await setup(three.slice(0, 1));
    await Bun.write(join(repo, ".bunker", "watch-state.json"), JSON.stringify({ lastAuditAt: Date.now() - 31 * 24 * 3_600_000 }));
    const calls: string[] = [];
    await run(repo, calls, 1);
    expect(calls).toHaveLength(1);
  });

  test("is off by default", async () => {
    const { repo } = await setup(three.slice(0, 1));
    const calls: string[] = [];
    const ctl = new AbortController();
    await runWatch({ ...base, cwd: repo, agent: fakeAgent(), auditor: auditor(calls), signal: ctl.signal, log: (l) => { if (/pass 1 /.test(l)) ctl.abort(); } });
    expect(calls).toHaveLength(0);
  });
});

describe("runWatch()", () => {
  test("runs passes until stopped, one line per pass", async () => {
    const { repo } = await setup(three.slice(0, 2));
    const ctl = new AbortController();
    const lines: string[] = [];
    const s = await runWatch({
      ...base, cwd: repo, agent: fakeAgent(), signal: ctl.signal,
      log: (l) => { lines.push(l); if (/pass 2 /.test(l)) ctl.abort(); },
    });
    const passes = lines.filter((l) => /bunker: pass \d+ /.test(l));
    expect(passes[0]).toMatch(/pass 1 · 2 merged · next pass in /);
    expect(passes[1]).toMatch(/pass 2 · 0 merged · next pass in /);
    expect(s.passes).toBe(2);
    expect(s.merged).toBe(2);
  });

  test("a failing issue is relabelled and commented, never retried, and the next issue runs", async () => {
    const { repo, root } = await setup(three.slice(0, 2));
    const ctl = new AbortController();
    const prompts: string[] = [];
    const s = await runWatch({
      ...base, cwd: repo, agent: fakeAgent({ failing: ["First"], prompts }), signal: ctl.signal,
      log: (l) => { if (/pass 2 /.test(l)) ctl.abort(); },
    });
    expect(s.merged).toBe(1);
    expect(s.failed).toBe(1);
    const gh = await Bun.file(join(root, "gh.log")).text();
    expect(gh).toContain("label create bunker-failed");
    expect(gh).toContain("issue edit 1 --remove-label bunker --add-label bunker-failed");
    expect(gh).not.toContain("issue edit 2");
    const comments = await Bun.file(join(root, "comments.log")).text();
    expect(comments).toMatch(/failed/);
    expect(comments).toContain("agent exited with 1");
    expect(comments).toMatch(/\.bunker\/runs\//);
    expect(prompts.filter((p) => p.includes("Title: First"))).toHaveLength(1);
  });

  test("notifies on a failed issue, a merging pass and the stop; the failed comment @-mentions the user", async () => {
    const { repo, root } = await setup(three.slice(0, 2));
    const ctl = new AbortController();
    await runWatch({
      ...base, cwd: repo, agent: fakeAgent({ failing: ["First"] }), signal: ctl.signal, notify: true, githubUser: "alice",
      log: (l) => { if (/pass 2 /.test(l)) ctl.abort(); },
    });
    const lines = (await Bun.file(join(root, "notify.log")).text()).trim().split("\n");
    expect(lines.filter((l) => /issue failed/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /pass merged PRs/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /watcher stopped/.test(l))).toHaveLength(1);
    expect(lines).toHaveLength(3);
    expect(await Bun.file(join(root, "comments.log")).text()).toContain("COMMENT: --body @alice");
  });

  test("notify: false silences everything, and the owner (a user) is @-mentioned by default", async () => {
    const { repo, root } = await setup(three.slice(0, 2));
    await Bun.write(join(root, "bin", "gh"), (await Bun.file(join(root, "bin", "gh")).text()).replace('if [ "$1" = "api" ]; then case', 'if [ "$1" = "api" ]; then case "$2" in "repos/{owner}/{repo}") echo "User bob"; exit 0;; esac; case'));
    const ctl = new AbortController();
    await runWatch({
      ...base, cwd: repo, agent: fakeAgent({ failing: ["First"] }), signal: ctl.signal, notify: false,
      log: (l) => { if (/pass 2 /.test(l)) ctl.abort(); },
    });
    expect(existsSync(join(root, "notify.log"))).toBe(false);
    expect(await Bun.file(join(root, "comments.log")).text()).toContain("COMMENT: --body @bob");
  });

  const notifyLines = async (root: string) => (existsSync(join(root, "notify.log")) ? (await Bun.file(join(root, "notify.log")).text()).trim().split("\n") : []);

  test("a spend cap notifies once", async () => {
    const { repo, root } = await setup(three);
    await runWatch({ ...base, cwd: repo, agent: fakeAgent({ cost: 15 }), maxCostUsd: 20, forMs: 400, notify: true, log: () => {} });
    expect((await notifyLines(root)).filter((l) => /spend cap reached/.test(l))).toHaveLength(1);
  });

  test("a blocked issue notifies once and its comment @-mentions the user", async () => {
    const { repo, root } = await setup(three.slice(0, 1));
    const ctl = new AbortController();
    await runWatch({
      ...base, cwd: repo, agent: fakeAgent({ blocked: ["First"] }), signal: ctl.signal, notify: true, githubUser: "alice",
      log: (l) => { if (/pass 1 /.test(l)) ctl.abort(); },
    });
    expect((await notifyLines(root)).filter((l) => /issue blocked/.test(l))).toHaveLength(1);
    expect(await Bun.file(join(root, "comments.log")).text()).toContain("COMMENT: --body @alice Blocked by #100: Need the thing");
  });

  test("a crash notifies once, with the secret in its message redacted, and rethrows", async () => {
    const { repo, root } = await setup(three.slice(0, 1));
    await expect(
      runWatch({ ...base, cwd: repo, agent: fakeAgent(), notify: true, log: (l) => { if (/pass 1 /.test(l)) throw new Error("kaboom ghp_abcdefghijklmnop1234"); } }),
    ).rejects.toThrow(/kaboom/);
    const lines = await notifyLines(root);
    expect(lines.filter((l) => /watcher crashed/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /watcher stopped/.test(l))).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("ghp_abcdefghijklmnop1234");
  });

  test("the default mention is skipped when the repo owner is an organisation", async () => {
    const { repo, root } = await setup(three.slice(0, 1));
    await Bun.write(join(root, "bin", "gh"), (await Bun.file(join(root, "bin", "gh")).text()).replace('if [ "$1" = "api" ]; then case', 'if [ "$1" = "api" ]; then case "$2" in "repos/{owner}/{repo}") echo "Organization acme"; exit 0;; esac; case'));
    const ctl = new AbortController();
    await runWatch({ ...base, cwd: repo, agent: fakeAgent({ failing: ["First"] }), signal: ctl.signal, log: (l) => { if (/pass 1 /.test(l)) ctl.abort(); } });
    const comments = await Bun.file(join(root, "comments.log")).text();
    expect(comments).toContain("did not merge");
    expect(comments).not.toContain("@");
  });

  test("a failed relabel never makes the same watcher retry the issue", async () => {
    const { repo, root } = await setup(three.slice(0, 1));
    await Bun.write(join(root, "edit-fails"), "");
    const ctl = new AbortController();
    const prompts: string[] = [];
    await runWatch({
      ...base, cwd: repo, agent: fakeAgent({ failing: ["First"], prompts }), signal: ctl.signal,
      log: (l) => { if (/pass 3 /.test(l)) ctl.abort(); },
    });
    expect(prompts.filter((p) => p.includes("Title: First"))).toHaveLength(1);
  });

  test("secrets are redacted from the failure comment", async () => {
    const { repo, root } = await setup(three.slice(0, 1));
    const agent = fakeAgent();
    const ctl = new AbortController();
    await runWatch({ ...base, verify: "echo ghp_abcdefghijklmnop1234; exit 1", cwd: repo, agent, signal: ctl.signal, log: (l) => { if (/pass 1 /.test(l)) ctl.abort(); } });
    const comments = await Bun.file(join(root, "comments.log")).text();
    expect(comments).toContain("[REDACTED]");
    expect(comments).not.toContain("ghp_abcdefghijklmnop1234");
  });

  test("spend from a run that throws after the agents ran counts toward the cap", async () => {
    const { repo } = await setup(three);
    const inner = noSandbox();
    // The agents run fine; the sandboxed verify step blows up.
    const sandbox: Sandbox = { exec: (cmd, ctx) => (cmd.join(" ").includes("(true)") ? Promise.reject(new Error("sandbox exploded")) : inner.exec(cmd, ctx)) };
    const s = await runWatch({ ...base, sandbox, cwd: repo, agent: fakeAgent({ cost: 15 }), maxCostUsd: 20, forMs: 400, log: () => {} });
    expect(s.failed).toBe(1);
    expect(s.spentUsd).toBeCloseTo(30);
    const spend = JSON.parse(await Bun.file(join(repo, ".bunker", "watch-spend.json")).text());
    expect(spend.reduce((a: number, e: { usd: number }) => a + e.usd, 0)).toBeCloseTo(30);
  });

  test("the spend cap stops work and persists spend", async () => {
    const { repo } = await setup(three);
    const lines: string[] = [];
    const s = await runWatch({
      ...base, cwd: repo, agent: fakeAgent({ cost: 15 }), maxCostUsd: 20, forMs: 400, log: (l) => lines.push(l),
    });
    expect(s.merged).toBe(1); // 2 runs × $15 per issue crosses $20 after the first issue
    expect(s.spentUsd).toBeCloseTo(30);
    expect(lines.some((l) => /spend cap/i.test(l))).toBe(true);
    const spend = JSON.parse(await Bun.file(join(repo, ".bunker", "watch-spend.json")).text());
    expect(spend.reduce((a: number, e: { usd: number }) => a + e.usd, 0)).toBeCloseTo(30);
    expect(await Bun.file(join(repo, ".git", "info", "exclude")).text()).toContain(".bunker/watch-spend.json");
  });

  test("spend from the last 24 h blocks work; older spend does not", async () => {
    const { repo } = await setup(three.slice(0, 1));
    await Bun.write(join(repo, ".bunker", "watch-spend.json"), JSON.stringify([{ at: Date.now() - 3_600_000, usd: 25 }]));
    const prompts: string[] = [];
    await runWatch({ ...base, cwd: repo, agent: fakeAgent({ prompts }), maxCostUsd: 20, forMs: 300, log: () => {} });
    expect(prompts).toHaveLength(0);

    await Bun.write(join(repo, ".bunker", "watch-spend.json"), JSON.stringify([{ at: Date.now() - 25 * 3_600_000, usd: 25 }]));
    const s = await runWatch({ ...base, cwd: repo, agent: fakeAgent({ prompts }), maxCostUsd: 20, forMs: 1500, log: () => {} });
    expect(s.merged).toBe(1);
  });

  test("a monthly cap stops new work even when the day cap is clear", async () => {
    const { repo } = await setup(three.slice(0, 1));
    await Bun.write(join(repo, ".bunker", "watch-spend.json"), JSON.stringify([{ at: Date.now() - 5 * 24 * 3_600_000, usd: 50 }]));
    const prompts: string[] = [];
    const lines: string[] = [];
    await runWatch({ ...base, cwd: repo, agent: fakeAgent({ prompts }), maxCostDayUsd: 20, maxCostMonthUsd: 40, forMs: 300, log: (l) => lines.push(l) });
    expect(prompts).toHaveLength(0);
    expect(lines.some((l) => /monthly spend cap/i.test(l))).toBe(true);
  });

  test("no caps: never stops, and the pass summary reports spend", async () => {
    const { repo } = await setup(three);
    await Bun.write(join(repo, ".bunker", "watch-spend.json"), JSON.stringify([{ at: Date.now() - 1000, usd: 500 }]));
    const lines: string[] = [];
    const s = await runWatch({ ...base, cwd: repo, agent: fakeAgent({ cost: 15 }), forMs: 400, log: (l) => lines.push(l) });
    expect(s.merged).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => /cap reached/i.test(l))).toBe(false);
    expect(lines.some((l) => /pass 1 .*\$.* today \(no cap\)/.test(l))).toBe(true);
  });

  test("maxCostUsd is an alias of maxCostDayUsd", async () => {
    const { repo } = await setup(three.slice(0, 1));
    await Bun.write(join(repo, ".bunker", "watch-spend.json"), JSON.stringify([{ at: Date.now() - 1000, usd: 25 }]));
    const prompts: string[] = [];
    await runWatch({ ...base, cwd: repo, agent: fakeAgent({ prompts }), maxCostUsd: 20, forMs: 300, log: () => {} });
    expect(prompts).toHaveLength(0);
  });

  test("when --for is up, no new issue starts and the in-flight one finishes", async () => {
    const { repo } = await setup(three);
    const s = await runWatch({ ...base, cwd: repo, agent: fakeAgent({ slow: 1 }), forMs: 300, log: () => {} });
    expect(s.merged).toBe(1);
  });

  test("a live lock refuses a second watcher; a stale lock is taken over", async () => {
    const { repo } = await setup([]);
    await Bun.write(join(repo, ".bunker", "watch.lock"), String(process.pid));
    await expect(runWatch({ ...base, cwd: repo, agent: fakeAgent(), forMs: 100, log: () => {} })).rejects.toThrow(/already running/);
    expect(existsSync(join(repo, ".bunker", "watch.lock"))).toBe(true);

    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await Bun.write(join(repo, ".bunker", "watch.lock"), String(dead.pid));
    await runWatch({ ...base, cwd: repo, agent: fakeAgent(), forMs: 100, log: () => {} });
    expect(existsSync(join(repo, ".bunker", "watch.lock"))).toBe(false);
  });

  test("two concurrent watchers: the second is refused", async () => {
    const { repo } = await setup([]);
    const ctl = new AbortController();
    const first = runWatch({ ...base, cwd: repo, agent: fakeAgent(), signal: ctl.signal, log: () => {} });
    await Bun.sleep(100);
    await expect(runWatch({ ...base, cwd: repo, agent: fakeAgent(), forMs: 100, log: () => {} })).rejects.toThrow(/already running/);
    ctl.abort();
    await first;
  });
});

describe("runWatch() next pass", () => {
  const long = { ...base, intervalMs: 600_000 };

  test("an issue labelled during pass 1 starts right after it, not after --interval", async () => {
    const { repo, root } = await setup(three.slice(0, 1));
    await Bun.write(join(root, "issue-2.json"), JSON.stringify({ number: 2, title: "Second", body: "Do it.", state: "OPEN", labels: [{ name: "bunker" }] }));
    // The list lags: issue 2 only shows up in the end-of-pass re-list (list calls: 2 initial + 1 re-list).
    await Bun.write(join(root, "q", "2.json"), JSON.stringify({ number: 2, title: "Second", createdAt: "2026-02-01T00:00:00Z" }));
    await Bun.write(join(root, "hide-2"), "3");
    const ctl = new AbortController();
    const lines: string[] = [];
    const started = Date.now();
    const s = await runWatch({
      ...long, cwd: repo, agent: fakeAgent(), signal: ctl.signal,
      log: (l) => { lines.push(l); if (/pass 2 /.test(l)) ctl.abort(); },
    });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(s.merged).toBe(2);
    expect(lines.find((l) => /pass 1 /.test(l))).toMatch(/next pass now \(1 waiting\)/);
  });

  test("an empty queue sleeps --interval", async () => {
    const { repo } = await setup([]);
    const lines: string[] = [];
    const s = await runWatch({ ...long, cwd: repo, agent: fakeAgent(), forMs: 600, log: (l) => lines.push(l) });
    expect(s.passes).toBe(1);
    expect(lines.find((l) => /pass 1 /.test(l))).toMatch(/next pass in 10 min/);
  });

  test("a queue holding only blocked issues sleeps and does not spin", async () => {
    const { repo, root } = await setup(three.slice(0, 1));
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Blocked by #99", state: "OPEN", labels: [{ name: "bunker" }] }));
    await Bun.write(join(root, "issue-99.json"), JSON.stringify({ number: 99, title: "Other", body: "", state: "OPEN", labels: [] }));
    const prompts: string[] = [];
    const lines: string[] = [];
    const s = await runWatch({ ...long, cwd: repo, agent: fakeAgent({ prompts }), forMs: 800, log: (l) => lines.push(l) });
    expect(prompts).toHaveLength(0);
    expect(s.passes).toBe(1);
    expect(lines.find((l) => /pass 1 /.test(l))).toMatch(/next pass in 10 min/);
  });

  test("two passes that do nothing sleep even if issues still look waiting", async () => {
    // A held-open issue that is never started (skipped as already handled would not count; this one is simply unstartable).
    const { repo, root } = await setup(three.slice(0, 1));
    await Bun.write(join(root, "issue-1.json"), JSON.stringify({ number: 1, title: "First", body: "Do it.", state: "OPEN", labels: [] })); // list lags: view says no longer labelled
    const lines: string[] = [];
    const s = await runWatch({ ...long, cwd: repo, agent: fakeAgent(), forMs: 1500, log: (l) => lines.push(l) });
    expect(s.passes).toBeLessThanOrEqual(2);
    expect(lines.filter((l) => /next pass in/.test(l))).toHaveLength(1);
  });
});

describe("bunker --watch (CLI)", () => {
  const run = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { cwd, env: process.env });
    return { code: p.exitCode, err: p.stderr.toString(), out: p.stdout.toString() };
  };

  test("without a verify command it exits 2", async () => {
    const { repo } = await setup([]);
    const r = run(repo, "--watch", "--no-sandbox");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/verify/);
  });

  test("invalid --for, --interval, --max-cost exit 2", async () => {
    const { repo } = await setup([]);
    for (const a of [["--for", "5x"], ["--interval", "0"], ["--max-cost", "-1"], ["--max-cost-day", "0"], ["--max-cost-month", "abc"]]) {
      expect(run(repo, "--watch", "--no-sandbox", "--verify", "true", ...a).code).toBe(2);
    }
  });

  test("SIGINT finishes cleanly and exits 0", async () => {
    const { repo } = await setup([]);
    await Bun.write(join(repo, ".bunker", "verify"), "true");
    const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "--watch", "--no-sandbox", "--interval", "0.01"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env });
    const reader = p.stdout.getReader();
    let seen = "";
    while (!/pass 1 /.test(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    p.kill("SIGINT");
    expect(await p.exited).toBe(0);
    expect(existsSync(join(repo, ".bunker", "watch.lock"))).toBe(false);
  });
});
