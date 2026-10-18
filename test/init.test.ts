import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { detectToolchain, runInit, upsertEnvVar, type Io } from "../src/cli/commands/init.ts";
import { cleanup, fakeWorld } from "./fakes.ts";

setDefaultTimeout(60_000); // see test/setup.ts
afterEach(cleanup);

const exists = (p: string) => Bun.file(p).exists();

/** An Io that answers from a script: confirm → yes unless listed in `no`; ask/secret from queues. */
function scripted(o: { no?: RegExp[]; asks?: string[]; secrets?: string[] } = {}) {
  const said: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    say: (s) => void said.push(s),
    confirm: async (q) => (asked.push(q), !o.no?.some((r) => r.test(q))),
    ask: async (q, def) => (asked.push(q), o.asks?.shift() ?? def ?? ""),
    secret: async (q) => (asked.push(q), o.secrets?.shift() ?? ""),
  };
  return { io, said, asked, text: () => said.join("\n") };
}

async function bunRepo(opts: Parameters<typeof fakeWorld>[0] = {}) {
  const w = await fakeWorld({ files: { "labels.json": JSON.stringify([{ name: "bunker:queued" }]) }, ...opts });
  await rm(join(w.repo, ".bunker/verify"));
  await Bun.write(join(w.repo, "bun.lock"), "");
  return w;
}

describe("detectToolchain", () => {
  test("bun, pnpm, npm, composer, python", async () => {
    const w = await fakeWorld();
    const at = async (file: string) => {
      await Bun.$`rm -f ${w.repo}/bun.lock ${w.repo}/pnpm-lock.yaml ${w.repo}/package-lock.json ${w.repo}/composer.json ${w.repo}/pyproject.toml`;
      await Bun.write(join(w.repo, file), "");
      return detectToolchain(w.repo);
    };
    expect((await at("bun.lock"))?.setup).toBe("bun install --frozen-lockfile");
    expect((await at("bun.lock"))?.verify).toBe("bun test && bun run typecheck");
    expect((await at("pnpm-lock.yaml"))?.setup).toContain("pnpm install");
    expect((await at("package-lock.json"))?.setup).toBe("npm ci");
    expect((await at("composer.json"))?.setup).toContain("composer install");
    expect((await at("pyproject.toml"))?.name).toBe("python");
    await Bun.$`rm ${w.repo}/pyproject.toml`;
    expect(await detectToolchain(w.repo)).toBeUndefined();
  });
});

describe("init --yes", () => {
  test("redacts secrets in gh label create stderr", async () => {
    const w = await bunRepo({ files: { "label-create-err.txt": "denied for token github_pat_leakyleaky123", "labels.json": JSON.stringify([{ name: "bunker:queued" }]) } });
    const s = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io });
    expect(s.text()).toContain("could not create");
    expect(s.text()).not.toContain("github_pat_leakyleaky123");
    expect(s.text()).toContain("[REDACTED]");
  });

  test("bun repo: writes setup/verify defaults, creates missing labels, changes no repo settings", async () => {
    const w = await bunRepo({ files: { "repo.json": JSON.stringify({ default_branch: "main", allow_auto_merge: false }), "labels.json": JSON.stringify([{ name: "unrelated" }]) } });
    const s = scripted();
    await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io });
    const toml = Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text());
    expect(toml).toEqual({ setup: "bun install --frozen-lockfile", verify: "bun test && bun run typecheck" });
    expect(await exists(join(w.repo, ".bunker/setup"))).toBe(false);
    expect(await exists(join(w.repo, ".bunker/verify"))).toBe(false);
    expect(await Bun.file(join(w.repo, ".bunker/Dockerfile")).text()).toContain("FROM bunker-claude");
    const log = await w.log();
    for (const l of ["discovered", "bunker:queued", "bunker:in-progress", "bunker:failed", "bunker:review", "bunker:awaiting-review", "bunker-blocked", "priority:high", "priority:medium", "priority:low", "severity:high", "severity:medium"]) expect(log).toContain(`gh label create ${l}`);
    expect(log).not.toContain("gh label create bunker ");
    // only GETs: no repo-settings writes
    expect(log).not.toMatch(/--method|-X |--input|-f |-F |PATCH|PUT|POST/);
    expect(log).not.toMatch(/gh repo edit/);
    expect(s.text()).toMatch(/auto-merge/i);
    expect(s.text()).toMatch(/IaC/);
  });

  test("never overwrites an existing .bunker/verify", async () => {
    const w = await bunRepo();
    await Bun.write(join(w.repo, ".bunker/verify"), "make check\n");
    await runInit({ cwd: w.repo, env: w.env, yes: true, io: scripted().io });
    expect(await Bun.file(join(w.repo, ".bunker/verify")).text()).toBe("make check\n");
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toEqual({ setup: "bun install --frozen-lockfile" });
  });

  test("ignores .bunker/.env and .bunker/runs/ without touching tracked files", async () => {
    const w = await bunRepo();
    await runInit({ cwd: w.repo, env: w.env, yes: true, io: scripted().io });
    for (const p of [".bunker/.env", ".bunker/runs/x"]) {
      expect((await Bun.$`git -C ${w.repo} check-ignore -q ${p}`.nothrow()).exitCode).toBe(0);
    }
    expect(await exists(join(w.repo, ".gitignore"))).toBe(false);
  });

  test("returns 0 and prints the first command once doctor is green; else 1", async () => {
    const w = await bunRepo({ files: { "repo.json": JSON.stringify({ default_branch: "main", allow_auto_merge: false }) } });
    const s = scripted();
    expect(await runInit({ cwd: w.repo, env: w.env, yes: true, io: s.io })).toBe(1);
    expect(s.text()).not.toContain("bunker issue");
    const w2 = await bunRepo();
    await Bun.write(join(w2.data, "labels.json"), JSON.stringify(["bunker:queued", "bunker:in-progress", "bunker:failed", "bunker:review", "bunker:awaiting-review", "discovered", "bunker-blocked", "priority:high", "priority:medium", "priority:low", "severity:high", "severity:medium"].map((name) => ({ name }))));
    const s2 = scripted();
    expect(await runInit({ cwd: w2.repo, env: w2.env, yes: true, io: s2.io })).toBe(0);
    expect(s2.text()).toContain("bunker issue <n> --merge");
    expect(s2.text()).toContain("bunker watch");
  });
});

describe("init interactive", () => {
  test("stores both tokens 0600, validated, never echoed or in argv", async () => {
    const w = await bunRepo();
    const env = { ...w.env };
    delete (env as Record<string, string | undefined>).CLAUDE_CODE_OAUTH_TOKEN;
    delete (env as Record<string, string | undefined>).BUNKER_GH_TOKEN;
    const s = scripted({ secrets: ["sk-ant-oat01-secretclaude", "github_pat_secretgh123456"] });
    await runInit({ cwd: w.repo, env, yes: false, io: s.io });
    const file = join(w.home, ".config/bunker/.env");
    const body = await Bun.file(file).text();
    expect(body).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secretclaude");
    expect(body).toContain("BUNKER_GH_TOKEN=github_pat_secretgh123456");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const log = await w.log();
    expect(log).not.toContain("secretclaude");
    expect(log).not.toContain("secretgh");
    expect(log).toContain("claude setup-token");
    expect(s.text()).not.toContain("secretclaude");
    expect(s.text()).not.toContain("secretgh");
    expect(s.text()).toContain("Contents: Read and write");
    expect(s.text()).toContain("https://github.com/settings/personal-access-tokens/new");
    expect(await w.ghEnvLog()).toContain("TOKEN=github_pat_secretgh123456");
  });

  test("a GitHub token that fails validation is reported by permission and not stored", async () => {
    const w = await bunRepo({ files: { "issues.json": "", "labels.json": JSON.stringify([]) } });
    const env = { ...w.env };
    delete (env as Record<string, string | undefined>).BUNKER_GH_TOKEN;
    const s = scripted({ secrets: ["github_pat_badbad123456"] });
    await runInit({ cwd: w.repo, env, yes: false, io: s.io });
    expect(await exists(join(w.home, ".config/bunker/.env"))).toBe(false);
    expect(s.text()).toContain("Issues");
  });

  test("a GitHub token is not stored unvalidated when there is no GitHub origin", async () => {
    const w = await bunRepo();
    await Bun.$`git -C ${w.repo} remote remove origin`.quiet().nothrow();
    const env = { ...w.env };
    delete (env as Record<string, string | undefined>).BUNKER_GH_TOKEN;
    const s = scripted({ secrets: ["github_pat_unvalidated123"] });
    await runInit({ cwd: w.repo, env, yes: false, io: s.io });
    expect(await exists(join(w.home, ".config/bunker/.env"))).toBe(false);
    expect(s.text()).toContain("GitHub origin");
  });

  test("declining a file writes nothing; models go to the repo's .bunker/.env", async () => {
    const w = await bunRepo();
    const s = scripted({ no: [/config\.toml/, /\.bunker\/Dockerfile/, /label/i], asks: ["claude-sonnet-5-5", "claude-opus-5-5", "repo"] });
    await runInit({ cwd: w.repo, env: w.env, yes: false, io: s.io });
    expect(await exists(join(w.repo, ".bunker/config.toml"))).toBe(false);
    expect(await exists(join(w.repo, ".bunker/Dockerfile"))).toBe(false);
    expect(await w.log()).not.toContain("label create");
    const env = await Bun.file(join(w.repo, ".bunker/.env")).text();
    expect(env).toContain("BUNKER_MODEL=claude-sonnet-5-5");
    expect(env).toContain("BUNKER_REVIEWER_MODEL=claude-opus-5-5");
    expect(((await stat(join(w.repo, ".bunker/.env"))).mode & 0o777)).toBe(0o600);
  });
});

describe("upsertEnvVar", () => {
  test("creates 0600, replaces in place, keeps other lines, tightens loose modes", async () => {
    const w = await fakeWorld();
    const f = join(w.home, "x/.env");
    await upsertEnvVar(f, "A", "1");
    await upsertEnvVar(f, "B", "2");
    await Bun.$`chmod 644 ${f}`;
    await upsertEnvVar(f, "A", "3");
    expect(await Bun.file(f).text()).toBe("A=3\nB=2\n");
    expect((await stat(f)).mode & 0o777).toBe(0o600);
  });
});

describe("cli", () => {
  const cli = (w: Awaited<ReturnType<typeof fakeWorld>>, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { cwd: w.repo, env: w.env });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  test("bunker doctor exits 0 / 1", async () => {
    const w = await fakeWorld();
    const ok = cli(w, "doctor");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("✓");
    await Bun.write(join(w.data, "repo.json"), JSON.stringify({ default_branch: "main", allow_auto_merge: false }));
    const bad = cli(w, "doctor");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("✗");
  });
  test("bunker init --yes works non-interactively", async () => {
    const w = await bunRepo();
    const r = cli(w, "init", "--yes");
    expect(r.err).toBe("");
    expect(Bun.TOML.parse(await Bun.file(join(w.repo, ".bunker/config.toml")).text())).toMatchObject({ verify: "bun test && bun run typecheck" });
  });
  test("bunker init without a terminal and without --yes refuses", async () => {
    const w = await bunRepo();
    const r = cli(w, "init");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--yes");
  });
});
