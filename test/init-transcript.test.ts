import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { InitInterrupted, runInit, type Io } from "../src/cli/commands/init.ts";
import { detectToolchains, forPackage, workspacePackages } from "../src/cli/init/toolchain.ts";
import { makeUi } from "../src/cli/init/ui.ts";
import { setTomlKey } from "../src/cli/init/files.ts";
import { findStep } from "../src/cli/init/guide.ts";
import type { Sandbox } from "../src/sandboxes/exec.ts";
import { cleanup, fakeWorld } from "./fakes.ts";

setDefaultTimeout(60_000); // see test/setup.ts
afterEach(cleanup);

const exists = (p: string) => Bun.file(p).exists();

/** Scripted IO: confirms take their default unless matched; `answers` match asks by regex, then the default; `interruptAt` plays Ctrl-C. */
function scripted(o: { no?: RegExp[]; yes?: RegExp[]; answers?: [RegExp, string][]; secrets?: string[]; interruptAt?: RegExp } = {}) {
  const said: string[] = [];
  const asked: string[] = [];
  const hit = (q: string) => {
    asked.push(q);
    if (o.interruptAt?.test(q)) throw new InitInterrupted();
  };
  const io: Io = {
    say: (s) => void said.push(s),
    confirm: async (q, def = true) => (hit(q), def ? !o.no?.some((r) => r.test(q)) : !!o.yes?.some((r) => r.test(q))),
    ask: async (q, def) => (hit(q), o.answers?.find(([r]) => r.test(q))?.[1] ?? def ?? ""),
    secret: async (q) => (hit(q), o.secrets?.shift() ?? ""),
  };
  return { io, said, asked, text: () => said.join("\n") };
}

/** A sandbox whose commands answer from a queue; records what ran and whether it was isolated. */
function fakeSandbox(results: { code: number; stdout?: string }[] = []) {
  const calls: { cmd: string; isolate: boolean }[] = [];
  const sandbox: Sandbox = {
    exec: async (cmd, ctx) => {
      calls.push({ cmd: cmd[2]!, isolate: !!ctx.isolate });
      const r = results.shift() ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? "" };
    },
  };
  return { sandbox, calls };
}

/** A repo with a commit (the dry run needs HEAD) and the given files, doctor-red on config. */
async function repoWith(files: Record<string, string>, opts: Parameters<typeof fakeWorld>[0] = {}) {
  const w = await fakeWorld({ files: { "labels.json": JSON.stringify([{ name: "bunker:queued" }]) }, ...opts });
  await rm(join(w.repo, ".bunker/config.toml"));
  for (const [f, c] of Object.entries(files)) await Bun.write(join(w.repo, f), c);
  await Bun.$`git -C ${w.repo} add -A && git -C ${w.repo} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();
  const env = { ...w.env };
  return { ...w, env };
}

const noTokens = (env: Record<string, string>) => {
  delete (env as Record<string, string | undefined>).CLAUDE_CODE_OAUTH_TOKEN;
  delete (env as Record<string, string | undefined>).BUNKER_GH_TOKEN;
};

describe("transcript: fresh Node repo with no lockfile", () => {
  test("oriented steps, npm install / npm test, edit offer, confirm names each file, dry run isolates verify", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ name: "demo-node", scripts: { test: "node --test" } }) });
    const s = scripted();
    const sb = fakeSandbox();
    expect(await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: sb.sandbox, runBunker: async () => 0 })).toBeGreaterThanOrEqual(0);
    const t = s.text();
    for (let i = 1; i <= 8; i++) expect(t).toContain(`[${i}/8]`);
    expect(t).toContain("[4/8] Toolchain");
    expect(t).toContain("[5/8] Sandbox image");
    expect(t).toMatch(/Why this matters:/);
    expect(t).toContain("▰▰▰▰▱▱▱▱ 4 of 8");
    expect(t).toContain("Chosen: npm");
    expect(t).toContain("no lockfile");
    const toml = Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text());
    expect(toml).toEqual({ setup: "npm install", verify: "npm test" });
    expect(await Bun.file(join(w.repo, ".bunker/Dockerfile")).text()).toContain("node:22-slim");
    // every write is preceded by a confirm that names the file
    expect(s.asked).toContain("Write .bunker/config.toml?");
    expect(s.asked).toContain("Write .bunker/Dockerfile?");
    // setup has network (installs), verify is isolated
    expect(sb.calls).toEqual([
      { cmd: "(npm install) 2>&1", isolate: false },
      { cmd: "(npm test) 2>&1", isolate: true },
    ]);
    expect(t).toContain("setup and verify pass in the sandbox");
    // the summary says what was written and what's next
    expect(t).toContain("== Summary ==");
    expect(t).toContain("✓ .bunker/config.toml");
  });
});

describe("transcript: Bun repo", () => {
  test("bun test, plus typecheck only when package.json has the script", async () => {
    const a = await repoWith({ "bun.lock": "", "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }) });
    await runInit({ cwd: a.repo, env: a.env, yes: true, io: scripted().io, sandbox: fakeSandbox().sandbox });
    expect(Bun.TOML.parse(await Bun.file(join(a.repo, ".bunker/config.toml")).text())).toEqual({ setup: "bun install --frozen-lockfile", verify: "bun test && bun run typecheck" });
    const b = await repoWith({ "bun.lock": "", "package.json": JSON.stringify({}) });
    await runInit({ cwd: b.repo, env: b.env, yes: true, io: scripted().io, sandbox: fakeSandbox().sandbox });
    expect(Bun.TOML.parse(await Bun.file(join(b.repo, ".bunker/config.toml")).text())).toMatchObject({ verify: "bun test" });
  });
});

describe("transcript: unknown toolchain", () => {
  test("interactive: asks for the commands instead of guessing", async () => {
    const w = await repoWith({ "Makefile": "test:\n\ttrue\n" });
    const s = scripted({ answers: [[/^Setup command/, "make deps"], [/^Verify command/, "make test"]] });
    const sb = fakeSandbox();
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: sb.sandbox });
    expect(s.text()).toContain("Custom commands:");
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toEqual({ setup: "make deps", verify: "make test" });
    expect(sb.calls.map((c) => c.cmd)).toEqual(["(make deps) 2>&1", "(make test) 2>&1"]);
  });
  test("--yes: lists it as needing you, writes no config, doesn't hang", async () => {
    const w = await repoWith({ Makefile: "x" });
    const s = scripted();
    expect(await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io, sandbox: fakeSandbox().sandbox })).toBe(1);
    expect(await exists(join(w.repo, ".bunker/config.toml"))).toBe(false);
    expect(s.text()).toMatch(/Still to do:[\s\S]*no setup\/verify command[\s\S]*verify = /);
    expect(s.asked).toEqual([]);
  });
  test("several candidates: asks which, listing them", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "package-lock.json": "{}", "pyproject.toml": "" });
    const s = scripted({ answers: [[/^Numbers/, "6"]] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(s.text()).toMatch(/\[x\] 2\) npm[\s\S]*\[x\] 6\) python/);
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toMatchObject({ verify: "pytest" });
  });
  test("presets: detected are pre-selected, nothing detected selects nothing", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "package-lock.json": "{}" });
    const s = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(s.text()).toContain("[ ] 1) bun: setup bun install --frozen-lockfile, verify bun test");
    expect(s.text()).toContain("[x] 2) npm");
    expect(s.text()).not.toMatch(/\[x\] \d\) (bun|php|go)/);
    expect(s.text()).toMatch(/customi[sz]e[\s\S]*\.bunker\/config\.toml[\s\S]*verify = "npm test"/i);
    const n = await repoWith({ Makefile: "x" });
    const t = scripted();
    await runInit({ cwd: n.repo, env: n.env, yes: false, io: t.io, sandbox: fakeSandbox().sandbox });
    expect(t.text()).not.toContain("[x]");
    expect(t.text()).toContain("custom");
  });
  test("presets: several picks combine with && in list order, Dockerfile from each", async () => {
    const w = await repoWith({ Makefile: "x" });
    const s = scripted({ answers: [[/^Numbers/, "6 1"]] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    const toml = Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text());
    expect(toml).toEqual({ setup: "bun install --frozen-lockfile && pip install -r requirements.txt", verify: "bun test && pytest" });
    const df = await Bun.file(join(w.repo, ".bunker/Dockerfile")).text();
    expect(df).toContain("oven/bun");
    expect(df).toContain("python3");
  });
  test("presets: custom keeps the free-text prompts, even when something is detected", async () => {
    const w = await repoWith({ "package-lock.json": "{}", "package.json": "{}" });
    const s = scripted({ answers: [[/^Numbers/, "custom"], [/^Setup command/, "make deps"], [/^Verify command/, "make test"]] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toEqual({ setup: "make deps", verify: "make test" });
  });
  test("presets: --yes asks nothing and uses the detected toolchain", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "package-lock.json": "{}" });
    const s = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(s.asked.filter((q) => /^Numbers/.test(q))).toEqual([]);
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toEqual({ setup: "npm ci", verify: "npm test" });
  });
  test("monorepo: asks which package", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "package-lock.json": "{}", "packages/a/package.json": JSON.stringify({ name: "@x/a", scripts: { test: "x" } }), "packages/b/package.json": JSON.stringify({ name: "@x/b" }) });
    const s = scripted({ answers: [[/Which package/, "1"]] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(s.text()).toContain("monorepo");
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toMatchObject({ verify: "npm run test --workspace packages/a" });
  });
});

describe("transcript: a failing verify, then a fix", () => {
  test("shows the tail, offers to edit, retries, and saves the fix", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    const s = scripted({ answers: [[/^verify: /, "npm run check"]] });
    const sb = fakeSandbox([{ code: 0 }, { code: 1, stdout: "line1\nsh: 1: jest: not found\n" }, { code: 0 }, { code: 0 }]);
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: sb.sandbox });
    expect(s.text()).toContain("verify failed in the sandbox");
    expect(s.text()).toContain("| sh: 1: jest: not found");
    expect(s.asked).toContain("Edit the commands and retry?");
    expect(sb.calls.map((c) => c.cmd)).toContain("(npm run check) 2>&1");
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toMatchObject({ verify: "npm run check" });
    expect(s.text()).toContain("setup and verify pass in the sandbox");
  });
  test("can add a line to the Dockerfile instead", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    const s = scripted({ no: [/Edit the commands/], answers: [[/Dockerfile line/, "RUN apt-get install -y make"]] });
    const sb = fakeSandbox([{ code: 0 }, { code: 2, stdout: "make: not found" }, { code: 0 }, { code: 0 }]);
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: sb.sandbox });
    expect(await Bun.file(join(w.repo, ".bunker/Dockerfile")).text()).toMatch(/RUN apt-get install -y make\n$/);
    expect(s.text()).toContain("setup and verify pass in the sandbox");
  });
  test("--yes: reports the failure and a fix, no prompts", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    const s = scripted();
    const code = await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io, sandbox: fakeSandbox([{ code: 1, stdout: "boom" }]).sandbox });
    expect(code).toBe(1);
    expect(s.text()).toContain("setup failed in the sandbox");
    expect(s.text()).toMatch(/Still to do:[\s\S]*setup fails in the sandbox/);
  });
});

describe("transcript: Ctrl-C then re-run", () => {
  test("leaves no half-written files; the re-run skips what's done and says so", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    const s1 = scripted({ interruptAt: /^Write \.bunker\/Dockerfile\?/ });
    expect(await runInit({ cwd: w.repo, env: w.env, yes: false, io: s1.io, sandbox: fakeSandbox().sandbox })).toBe(130);
    expect(s1.text()).toContain("Interrupted");
    expect(await exists(join(w.repo, ".bunker/Dockerfile"))).toBe(false);
    expect((await readdir(join(w.repo, ".bunker"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toMatchObject({ verify: "npm test" });
    const s2 = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s2.io, sandbox: fakeSandbox().sandbox });
    expect(s2.asked).not.toContain("Write .bunker/config.toml?");
    expect(s2.asked).toContain("Write .bunker/Dockerfile?");
    expect(s2.text()).toMatch(/✓ setup and verify are set in \.bunker\/config\.toml.*already done, skipping/);
  });
  test("Ctrl-C while pasting a secret stores nothing", async () => {
    const w = await repoWith({ "package.json": "{}" });
    noTokens(w.env);
    const s = scripted({ interruptAt: /^Paste the token/ });
    expect(await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox })).toBe(130);
    expect(await exists(join(w.home, ".config/bunker/.env"))).toBe(false);
  });
});

describe("transcript: --yes", () => {
  test("takes every default, never asks, lists the steps that need a human, and sets the $20 cap", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "package-lock.json": "{}" });
    noTokens(w.env);
    const s = scripted();
    expect(await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io, sandbox: fakeSandbox().sandbox })).toBe(1);
    expect(s.asked).toEqual([]);
    const t = s.text();
    expect(t).toMatch(/Still to do:[\s\S]*Claude token[\s\S]*GitHub token/);
    expect(await Bun.file(join(w.home, ".config/bunker/config.toml")).text()).toContain("max_cost_day = 20");
    expect(await exists(join(w.home, ".config/bunker/.env"))).toBe(false);
  });
});

describe("transcript: NO_COLOR and colour", () => {
  test("NO_COLOR: no escape codes, ASCII marks", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    const s = scripted();
    await runInit({ cwd: w.repo, env: { ...w.env, NO_COLOR: "1", FORCE_COLOR: "1" }, yes: true, io: s.io, tty: true, sandbox: fakeSandbox().sandbox });
    const t = s.text();
    expect(t).not.toContain("\x1b");
    expect(t).toContain("[ok]");
    expect(t).not.toMatch(/[▰▱]/);
  });
  test("a colour terminal: coloured marks and a clickable (OSC 8) link", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    noTokens(w.env);
    const s = scripted({ secrets: [""] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, tty: true, sandbox: fakeSandbox().sandbox });
    const t = s.text();
    expect(t).toContain("\x1b[1m[1/8] Welcome");
    expect(t).toContain("\x1b]8;;https://github.com/settings/personal-access-tokens/new?");
  });
  test("ui: plain without a tty; wraps at 80 columns", () => {
    const ui = makeUi({}, { tty: false, columns: 200 });
    expect(ui.color).toBe(false);
    expect(ui.link("https://x.test", "x")).toBe("x (https://x.test)");
    const wrapped = ui.wrap("word ".repeat(60), 2);
    expect(Math.max(...wrapped.split("\n").map((l) => l.length))).toBeLessThanOrEqual(80);
  });
  test("every line of the guidance fits 80 columns", async () => {
    const w = await repoWith({ "package.json": "{}" });
    noTokens(w.env);
    const s = scripted({ secrets: [""] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    const long = s.text().split("\n").filter((l) => l.length > 80 && !/https?:|fix:|^\s+[✓✗·] /.test(l));
    expect(long).toEqual([]);
  });
});

describe("--explain", () => {
  test("re-reads a step's guidance by number or name, and rejects an unknown one", async () => {
    const w = await repoWith({});
    const s = scripted();
    expect(await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, explain: "3" })).toBe(0);
    expect(s.text()).toContain("[3/8] GitHub identity");
    expect(s.text()).toContain("Workflows: NO");
    expect(s.asked).toEqual([]);
    expect(findStep("merge")?.index).toBe(5);
    expect(findStep("sandbox")?.index).toBe(4);
    const bad = scripted();
    expect(await runInit({ cwd: w.repo, env: w.env, yes: false, io: bad.io, explain: "nope" })).toBe(2);
    expect(bad.text()).toContain("Steps:");
  });
  test("the cli accepts it without a terminal", async () => {
    const w = await repoWith({});
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "init", "--explain", "merge"], { cwd: w.repo, env: w.env });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("Classic");
  });
});

describe("step 3: GitHub token guidance", () => {
  test("exact checklist with reasons, a pre-filled link, and the optional App path offered as advanced", async () => {
    const w = await repoWith({ "package.json": "{}" });
    noTokens(w.env);
    const s = scripted({ secrets: ["", ""] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    const t = s.text();
    for (const line of ["Contents: Read and write", "Pull requests: Read and write", "Issues: Read and write", "Metadata: Read", "Actions: Read", "Workflows: leave at No access"]) expect(t).toContain(line);
    expect(t).toContain("contents=write&pull_requests=write&issues=write&actions=read");
    expect(t).toContain("Advanced, skip unless you know you need it");
    expect(s.asked.find((q) => /separate GitHub identity/.test(q))).toBeDefined();
  });
  test("a token that looks wrong is not saved unless confirmed", async () => {
    const w = await repoWith({ "package.json": "{}" });
    noTokens(w.env);
    const s = scripted({ secrets: ["not-a-token"] });
    await runInit({ cwd: w.repo, env: { ...w.env, BUNKER_GH_TOKEN: "github_pat_ok123456" }, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(await exists(join(w.home, ".config/bunker/.env"))).toBe(false);
    expect(s.text()).toContain("Still to do");
  });
});

describe("step 6: merge safety", () => {
  const redRepo = async (extra: Record<string, string> = {}) => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }), ...extra }, { files: { "repo.json": JSON.stringify({ default_branch: "main", allow_auto_merge: false }), "rules.json": "[]", "labels.json": JSON.stringify([{ name: "bunker:queued" }]) } });
    await rm(join(w.repo, ".github/workflows/ci.yml"), { force: true });
    await Bun.$`git -C ${w.repo} add -A && git -C ${w.repo} -c user.name=t -c user.email=t@t commit -q -m rm-ci --allow-empty`.quiet();
    return w;
  };
  test("writes the CI workflow on a branch with a PR, never on the default branch; creates the ruleset and enables auto-merge via the user's gh", async () => {
    const w = await redRepo();
    const bare = join(w.root, "origin.git");
    await Bun.$`git init -q --bare ${bare}`.quiet();
    await Bun.$`git -C ${w.repo} config url.${bare}.pushInsteadOf https://github.com/o/r.git`.quiet();
    await Bun.$`git -C ${w.repo} config user.name t && git -C ${w.repo} config user.email t@t`.quiet();
    const before = (await Bun.$`git -C ${w.repo} rev-parse main`.text()).trim();
    const s = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox, runBunker: async () => 0 });
    expect((await Bun.$`git -C ${w.repo} rev-parse main`.text()).trim()).toBe(before);
    expect(await exists(join(w.repo, ".github/workflows/ci.yml"))).toBe(false);
    const wf = await Bun.$`git --git-dir=${bare} show bunker/init-ci:.github/workflows/ci.yml`.text();
    expect(wf).toContain("  test:");
    expect(wf).toContain('- run: "npm test"');
    expect((await Bun.$`git --git-dir=${bare} rev-parse refs/heads/main`.nothrow().quiet()).exitCode).not.toBe(0);
    const log = await w.log();
    expect(log).toContain("gh pr create --repo o/r --base main --head bunker/init-ci");
    expect(log).toContain("gh api repos/o/r/rulesets --method POST");
    expect(log).toContain("gh api repos/o/r --method PATCH -F allow_auto_merge=true");
    expect(s.asked.some((q) => q.includes(".github/workflows/ci.yml") && q.includes("`test`") && /PR/.test(q))).toBe(true);
    expect(s.text()).toContain("https://github.com/o/r/pull/1");
    expect(s.text()).toMatch(/Still to do:[\s\S]*CI workflow PR not merged yet/);
  });
  test("a refused ruleset prints the exact clicks, says classic protection doesn't count, and mentions IaC", async () => {
    const w = await redRepo();
    await Bun.write(join(w.data, "ruleset-err.txt"), "HTTP 403: Must have admin rights to Repository.");
    const s = scripted({ no: [/workflow|PR/] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    const t = s.text();
    expect(t).toContain("Could not create it: your gh login can't administer this repo");
    expect(t).toContain("https://github.com/o/r/settings/rules");
    expect(t).toContain("classic");
    expect(t).toMatch(/Require status checks to pass/);
    expect(t).toContain("IaC");
  });
  test("an IaC-managed repo is detected: no ruleset write is attempted", async () => {
    const w = await redRepo({ "terraform/main.tf": 'resource "github_repository" "r" {}\n' });
    const s = scripted({ no: [/workflow|PR/] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(s.text()).toContain("managed by IaC: terraform (terraform/main.tf)");
    expect(await w.log()).not.toContain("rulesets --method POST");
    expect(s.asked.some((q) => /ruleset/i.test(q))).toBe(false);
  });
  test("--yes changes no repo setting and opens no PR, but lists the clicks", async () => {
    const w = await redRepo();
    const s = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io, sandbox: fakeSandbox().sandbox });
    const log = await w.log();
    expect(log).not.toContain("pr create");
    expect(log).not.toContain("--method");
    expect(s.text()).toMatch(/Still to do:[\s\S]*auto-merge[\s\S]*no ruleset/);
  });
});

describe("step 8: guided first task", () => {
  test("offered once everything is green; creates the issue and runs it attended, without --merge", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { files: { "labels.json": JSON.stringify(["bunker:queued", "bunker:in-progress", "bunker:failed", "bunker:review", "bunker:awaiting-review", "discovered", "bunker-blocked", "priority:high", "priority:medium", "priority:low", "severity:high", "severity:medium"].map((name) => ({ name }))) } });
    const ran: string[][] = [];
    const s = scripted();
    expect(await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox, runBunker: async (a) => (ran.push(a), 0) })).toBe(0);
    expect(ran).toEqual([["issue", "7"]]);
    expect(await w.log()).toContain("gh issue create --repo o/r");
    expect(s.text()).toContain("bunker issue <n> --merge");
  });
  test("declining creates nothing", async () => {
    const w = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { files: { "labels.json": JSON.stringify(["bunker:queued", "bunker:in-progress", "bunker:failed", "bunker:review", "bunker:awaiting-review", "discovered", "bunker-blocked", "priority:high", "priority:medium", "priority:low", "severity:high", "severity:medium"].map((name) => ({ name }))) } });
    const ran: string[][] = [];
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: scripted({ no: [/hello bunker/] }).io, sandbox: fakeSandbox().sandbox, runBunker: async (a) => (ran.push(a), 0) });
    expect(ran).toEqual([]);
    expect(await w.log()).not.toContain("issue create");
  });
});

describe("step 7: spend", () => {
  test("daily default 20 and an optional monthly cap go to the user config after a confirm naming it; a re-run skips", async () => {
    const w = await repoWith({ "package.json": "{}" });
    const s = scripted({ answers: [[/Monthly/, "300"]] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io, sandbox: fakeSandbox().sandbox });
    expect(s.asked.some((q) => q.includes("max_cost_day = 20 and max_cost_month = 300") && q.includes("config.toml"))).toBe(true);
    expect(Bun.TOML.parse(await Bun.file(join(w.home, ".config/bunker/config.toml")).text())).toEqual({ max_cost_day: 20, max_cost_month: 300 });
    const again = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: again.io, sandbox: fakeSandbox().sandbox });
    expect(again.asked.some((q) => /spend cap/i.test(q))).toBe(false);
    expect(again.text()).toContain("a daily spend cap is set (already done, skipping)");
  });
});

describe("toolchain detection", () => {
  const at = async (files: Record<string, string>) => {
    const w = await fakeWorld();
    for (const [f, c] of Object.entries(files)) await Bun.write(join(w.repo, f), c);
    return w.repo;
  };
  test("npm without a lockfile, pnpm/yarn by packageManager, composer, cargo, go", async () => {
    expect(detectToolchains(await at({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }))[0]).toMatchObject({ name: "npm", setup: "npm install", verify: "npm test" });
    expect(detectToolchains(await at({ "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0", scripts: { test: "x" } }) }))[0]).toMatchObject({ name: "pnpm", setup: "pnpm install" });
    expect(detectToolchains(await at({ "package.json": JSON.stringify({ packageManager: "yarn@4.0.0", scripts: { test: "x" } }) }))[0]?.name).toBe("yarn");
    expect(detectToolchains(await at({ "package.json": "{}", "yarn.lock": "" }))[0]).toMatchObject({ name: "yarn", setup: "yarn install --frozen-lockfile" });
    expect(detectToolchains(await at({ "composer.json": "{}" }))[0]?.name).toBe("php");
    expect(detectToolchains(await at({ "Cargo.toml": "" }))[0]).toMatchObject({ name: "rust", verify: "cargo test" });
    expect(detectToolchains(await at({ "go.mod": "" }))[0]).toMatchObject({ name: "go", verify: "go test ./..." });
    expect(detectToolchains(await at({ "requirements.txt": "" }))[0]).toMatchObject({ name: "python", setup: "pip install -r requirements.txt" });
    expect(detectToolchains(await at({}))).toEqual([]);
  });
  test("php: composer.json in a subdirectory, no test script, version and extensions", async () => {
    const composer = JSON.stringify({ require: { php: ">=8.5", "ext-intl": "*", "ext-pdo_pgsql": "*", "ext-redis": "*", "ext-ctype": "*" } });
    const tc = detectToolchains(await at({ "backend/composer.json": composer }))[0]!;
    expect(tc.name).toBe("php");
    expect(tc.setup).toBe("cd backend && composer install --no-interaction");
    expect(tc.verify).toBe("cd backend && vendor/bin/phpunit");
    expect(tc.dockerfile).toContain("php8.5-cli");
    expect(tc.dockerfile).toContain("packages.sury.org");
    for (const e of ["php8.5-intl", "php8.5-pgsql", "php8.5-redis"]) expect(tc.dockerfile).toContain(e);
    expect(tc.dockerfile).not.toContain("ctype");
  });
  test("php: uses the composer test script when it exists, at the root", async () => {
    const tc = detectToolchains(await at({ "composer.json": JSON.stringify({ require: { php: "^8.2" }, scripts: { test: "phpunit" } }) }))[0]!;
    expect(tc).toMatchObject({ setup: "composer install --no-interaction", verify: "composer test" });
    expect(tc.dockerfile).toContain("php8.2-cli");
  });
  test("php: tests that need a database get no verify and a note", async () => {
    const ci = await at({ "composer.json": "{}", ".github/workflows/ci.yml": "jobs:\n  t:\n    services:\n      postgres:\n        image: postgres:18.1-alpine\n" });
    expect(detectToolchains(ci)[0]).toMatchObject({ verify: "" });
    expect(detectToolchains(ci)[0]!.note).toMatch(/database/i);
    const env = await at({ "composer.json": "{}", ".env.test": "DATABASE_URL=postgresql://app:pw@database:5432/app\n" });
    expect(detectToolchains(env)[0]!.verify).toBe("");
    const local = await at({ "composer.json": "{}", ".env.test": "DATABASE_URL=sqlite:///var/test.db\n" });
    expect(detectToolchains(local)[0]!.verify).not.toBe("");
  });
  test("a placeholder test script falls back to build, with a note", async () => {
    const tc = detectToolchains(await at({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: "tsc" } }), "package-lock.json": "{}" }))[0]!;
    expect(tc.verify).toBe("npm run build");
    expect(tc.note).toMatch(/no test script/);
  });
  test("workspaces from package.json and pnpm-workspace.yaml", async () => {
    const root = await at({ "package.json": JSON.stringify({ workspaces: { packages: ["apps/*"] } }), "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n", "apps/web/package.json": JSON.stringify({ name: "web" }), "libs/core/package.json": JSON.stringify({ name: "core", scripts: { build: "x" } }) });
    const pkgs = workspacePackages(root);
    expect(pkgs).toEqual([{ dir: "apps/web", name: "web" }, { dir: "libs/core", name: "core" }]);
    const tc = detectToolchains(root)[0]!;
    expect(forPackage(root, tc, pkgs[1]!).verify).toBe("pnpm --filter ./libs/core run build");
  });
});

describe("setTomlKey", () => {
  test("replaces in place, inserts before the first table, appends otherwise", () => {
    expect(setTomlKey("", "a", 1)).toBe("a = 1\n");
    expect(setTomlKey('a = 1\nb = "x"\n', "a", 2)).toBe('a = 2\nb = "x"\n');
    expect(setTomlKey("[watch]\nx = 1\n", "a", "v")).toBe('a = "v"\n\n[watch]\nx = 1\n');
    expect(setTomlKey("# c\nb = 1", "a", 3)).toBe("# c\nb = 1\na = 3\n");
  });
});
