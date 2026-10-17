import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { formatChecks, runDoctor } from "../src/doctor.ts";
import { cleanup, fakeWorld } from "./fakes.ts";

setDefaultTimeout(60_000); // see test/setup.ts
afterEach(cleanup);

const failed = (checks: { id: string; ok: boolean; required: boolean }[]) => checks.filter((c) => !c.ok && c.required).map((c) => c.id);

describe("doctor", () => {
  test("everything in place: all ✓, exit 0, read-only gh calls", async () => {
    const w = await fakeWorld();
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(failed(r.checks)).toEqual([]);
    expect(r.code).toBe(0);
    const log = await w.log();
    expect(log).not.toContain("label create");
    expect(log).not.toMatch(/--method|-X /);
    expect(formatChecks(r.checks)).toContain("✓");
    expect(formatChecks(r.checks)).not.toContain("✗");
  });

  test("the scoped token is passed via the environment, never argv", async () => {
    const w = await fakeWorld();
    await runDoctor({ cwd: w.repo, env: w.env });
    expect(await w.log()).not.toContain("github_pat_testtoken123");
    expect(await w.ghEnvLog()).toContain("TOKEN=github_pat_testtoken123");
  });

  test("reports each ✗ with a fix and exits 1", async () => {
    const w = await fakeWorld({
      files: { "labels.json": JSON.stringify([{ name: "bunker" }]), "repo.json": JSON.stringify({ default_branch: "main", allow_auto_merge: false }), "protection.json": "" },
      noTools: ["docker"],
    });
    await Bun.$`rm ${join(w.repo, ".github/workflows/ci.yml")} ${join(w.repo, ".bunker/verify")}`;
    const env = { ...w.env };
    delete (env as Record<string, string | undefined>).CLAUDE_CODE_OAUTH_TOKEN;
    const r = await runDoctor({ cwd: w.repo, env });
    expect(failed(r.checks)).toEqual(
      expect.arrayContaining(["docker", "auth-claude", "verify", "label-discovered", "label-bunker-failed", "label-bunker-blocked", "label-priority:high", "label-priority:medium", "label-priority:low", "auto-merge", "ci", "required-check"]),
    );
    expect(failed(r.checks)).not.toContain("label-bunker");
    expect(r.code).toBe(1);
    for (const id of ["auto-merge", "required-check"]) expect(r.checks.find((c) => c.id === id)?.required).toBe(true);
    for (const c of r.checks.filter((c) => !c.ok && c.required)) expect(c.fix).toBeTruthy();
    const out = formatChecks(r.checks);
    expect(out).toContain("✗");
    expect(out).toContain("claude setup-token");
    expect(out).toContain("gh label create discovered");
    for (const id of ["label-severity:high", "label-severity:medium"]) {
      const c = r.checks.find((c) => c.id === id);
      expect(c?.ok).toBe(false);
      expect(c?.required).toBe(false);
      expect(c?.fix).toContain(`gh label create ${id.slice(6)}`);
    }
  });

  test("names the token permission gaps", async () => {
    const w = await fakeWorld({ files: { "issues.json": "", "pulls.json": "" } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    const c = r.checks.find((c) => c.id === "auth-gh")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Issues");
    expect(c.detail).toContain("Pull requests");
    expect(c.detail).not.toContain("Contents");
    expect(r.code).toBe(1);
  });

  test("unset BUNKER_GH_TOKEN fails with the fix", async () => {
    const w = await fakeWorld();
    const env = { ...w.env };
    delete (env as Record<string, string | undefined>).BUNKER_GH_TOKEN;
    const r = await runDoctor({ cwd: w.repo, env });
    expect(failed(r.checks)).toContain("auth-gh");
  });

  test("not a git repo / no github origin", async () => {
    const w = await fakeWorld();
    await Bun.$`git -C ${w.repo} remote set-url origin https://example.com/x/y.git`;
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(failed(r.checks)).toContain("origin");
    expect(r.code).toBe(1);
    const r2 = await runDoctor({ cwd: w.home, env: w.env });
    expect(failed(r2.checks)).toContain("repo");
  });

  test("optional files are noted, not failures; models are shown", async () => {
    const w = await fakeWorld();
    const r = await runDoctor({ cwd: w.repo, env: { ...w.env, BUNKER_REVIEWER_MODEL: "claude-opus-5-5" } });
    const out = formatChecks(r.checks);
    expect(r.code).toBe(0);
    expect(r.checks.find((c) => c.id === "setup")!.required).toBe(false);
    expect(out).toMatch(/reviewer: claude-opus-5-5/);
    expect(out).toMatch(/implementer: Claude default/);
  });

  test("ruleset required checks count", async () => {
    const w = await fakeWorld({ files: { "protection.json": "", "rules.json": JSON.stringify([{ type: "required_status_checks", parameters: {} }]) } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(failed(r.checks)).not.toContain("required-check");
  });
});

describe("labeler check", () => {
  test("passes when the token can read collaborator permissions, fails when it can't", async () => {
    const ok = await fakeWorld();
    expect((await runDoctor({ cwd: ok.repo, env: ok.env })).checks.find((c) => c.id === "labeler-check")?.ok).toBe(true);
    const bad = await fakeWorld({ files: { "permission.json": "" } });
    const r = await runDoctor({ cwd: bad.repo, env: bad.env });
    expect(r.checks.find((c) => c.id === "labeler-check")?.ok).toBe(false);
    expect(r.code).toBe(1);
  });
});

describe("doctor spend", () => {
  test("shows spend so far against the configured caps", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker", "watch-spend.json"), JSON.stringify([{ at: Date.now() - 1000, usd: 4 }]));
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(formatChecks(r.checks)).toContain("$4.00 today (no cap) · $4.00 this month (no cap)");
    expect(r.code).toBe(0);
  });
});

describe("doctor storage", () => {
  test("reports the size of runs/ and sessions/", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker", "runs", "1-a.log"), "x".repeat(2048));
    await Bun.write(join(w.repo, ".bunker", "sessions", "1", "s.jsonl"), "x".repeat(1024));
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(r.checks.find((c) => c.id === "runs-size")?.detail).toContain("2.0 KB");
    expect(r.checks.find((c) => c.id === "sessions-size")?.detail).toContain("1.0 KB");
    expect(r.code).toBe(0);
  });
});
