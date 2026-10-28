import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { formatChecks, runDoctor } from "../src/cli/commands/doctor.ts";
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
      files: { "labels.json": JSON.stringify([{ name: "bunker:queued" }]), "repo.json": JSON.stringify({ default_branch: "main", allow_auto_merge: false }), "rules.json": "" },
      noTools: ["docker"],
    });
    await Bun.$`rm ${join(w.repo, ".github/workflows/ci.yml")} ${join(w.repo, ".bunker/config.toml")}`;
    const env = { ...w.env };
    delete (env as Record<string, string | undefined>).CLAUDE_CODE_OAUTH_TOKEN;
    const r = await runDoctor({ cwd: w.repo, env });
    expect(failed(r.checks)).toEqual(
      expect.arrayContaining(["docker", "auth-claude", "verify", "label-discovered", "label-bunker:failed", "label-bunker-blocked", "label-priority:high", "label-priority:medium", "label-priority:low", "auto-merge", "ci", "required-check"]),
    );
    expect(failed(r.checks)).not.toContain("label-bunker");
    expect(r.code).toBe(1);
    for (const id of ["auto-merge", "required-check"]) expect(r.checks.find((c) => c.id === id)?.required).toBe(true);
    for (const c of r.checks.filter((c) => !c.ok && c.required)) expect(c.fix).toBeTruthy();
    const out = formatChecks(r.checks);
    expect(out).toContain("✗");
    expect(out).toContain("claude setup-token");
    expect(out).toContain("gh label create discovered");
    const aw = r.checks.find((c) => c.id === "label-bunker:awaiting-review");
    expect(aw?.ok).toBe(false);
    expect(aw?.required).toBe(false);
    for (const id of ["label-severity:high", "label-severity:medium"]) {
      const c = r.checks.find((c) => c.id === id);
      expect(c?.ok).toBe(false);
      expect(c?.required).toBe(false);
      expect(c?.fix).toContain(`gh label create ${id.slice(6)}`);
    }
  });

  test("reports old label names still on the repo, with the rename to run", async () => {
    const w = await fakeWorld({ files: { "labels.json": JSON.stringify([{ name: "bunker" }, { name: "bunker-failed" }, { name: "needs-human-review" }, { name: "bunker:queued" }]) } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    for (const [old, now] of [["bunker", "bunker:queued"], ["bunker-failed", "bunker:failed"], ["needs-human-review", "bunker:review"]]) {
      const c = r.checks.find((c) => c.id === `old-label-${old}`);
      expect(c?.ok).toBe(false);
      expect(c?.fix).toContain(`gh label edit ${old} --name ${now}`);
      expect(c?.fix).not.toContain("still works");
    }
    expect(r.checks.find((c) => c.id === "label-bunker:failed")?.fix).not.toContain("still works");
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

  test("shows the effective review paths and where each comes from", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker", "config.toml"), 'review_paths = ["src/gate/**"]\n');
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    const detail = r.checks.find((c) => c.id === "review-paths")!.detail!;
    expect(detail).toContain("package.json (default)");
    expect(detail).toContain("Makefile (default)");
    expect(detail).toContain("src/gate/** (config.toml)");
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
    const w = await fakeWorld({ files: { "rules.json": JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }]) } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(failed(r.checks)).not.toContain("required-check");
  });

  test("classic branch protection alone satisfies required-check", async () => {
    const w = await fakeWorld({ files: { "rules.json": "[]", "protection.json": JSON.stringify({ contexts: ["test"], checks: [{ context: "test" }] }) } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(failed(r.checks)).not.toContain("required-check");
  });

  test("ruleset and protection both set satisfies required-check", async () => {
    const w = await fakeWorld({ files: { "protection.json": JSON.stringify({ contexts: ["phpunit"], checks: [] }) } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(failed(r.checks)).not.toContain("required-check");
  });

  test("neither ruleset nor protection fails required-check", async () => {
    const w = await fakeWorld({ files: { "rules.json": "[]" } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    const c = r.checks.find((c) => c.id === "required-check")!;
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("ruleset");
    expect(c.fix).toContain("classic");
  });

  test("unreadable protection is reported as such, not as no required check", async () => {
    const w = await fakeWorld({ files: { "rules.json": "[]", "protection-err.txt": "HTTP 403: Resource not accessible by integration" } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    const c = r.checks.find((c) => c.id === "required-check")!;
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("could not read");
    expect(c.fix).toContain("Administration");
  });

  test("a ruleset status-check rule with no checks listed does not count", async () => {
    const w = await fakeWorld({ files: { "rules.json": JSON.stringify([{ type: "required_status_checks", parameters: {} }]) } });
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(failed(r.checks)).toContain("required-check");
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

describe("doctor removed user config keys", () => {
  test("flags kebab-case keys with the snake_case fix; clean config has no such check", async () => {
    const w = await fakeWorld();
    const xdg = join(w.repo, "xdg");
    const env = { ...w.env, XDG_CONFIG_HOME: xdg };
    expect((await runDoctor({ cwd: w.repo, env })).checks.find((c) => c.id === "config-removed-key")).toBeUndefined();
    await Bun.write(join(xdg, "bunker", "config.toml"), "max-cost-day = 5\n");
    const c = (await runDoctor({ cwd: w.repo, env })).checks.find((c) => c.id === "config-removed-key");
    expect(c?.ok).toBe(false);
    expect(c?.required).toBe(false);
    expect(c?.detail).toContain("max-cost-day");
    expect(c?.fix).toContain("max_cost_day");
  });

  test("a leftover .bunker/verify or .bunker/setup is reported with the config.toml fix", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/verify"), "true\n");
    await Bun.write(join(w.repo, ".bunker/setup"), "true\n");
    const checks = (await runDoctor({ cwd: w.repo, env: w.env })).checks.filter((c) => c.id === "config-removed-file");
    expect(checks.map((c) => c.label).sort()).toEqual([".bunker/setup", ".bunker/verify"]);
    expect(checks.every((c) => c.ok === false)).toBe(true);
    expect(checks.find((c) => c.label === ".bunker/verify")?.fix).toContain('verify = "…"');
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

describe("doctor: GitHub identity", () => {
  test("the PAT is reported by default", async () => {
    const w = await fakeWorld();
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    const c = r.checks.find((c) => c.id === "identity")!;
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("owner's PAT");
  });

  test("a bot account is reported and used for the probes", async () => {
    const w = await fakeWorld();
    const fetch = (async () => Response.json({ login: "my-bot" })) as unknown as typeof globalThis.fetch;
    const env: Record<string, string | undefined> = { ...w.env, BUNKER_BOT_GH_TOKEN: "github_pat_bottoken999" };
    const r = await runDoctor({ cwd: w.repo, env, fetch });
    expect(r.checks.find((c) => c.id === "identity")!.detail).toContain("bot account my-bot");
    expect(await w.ghEnvLog()).toContain("TOKEN=github_pat_bottoken999");
    expect(env.BUNKER_GH_TOKEN).toBe("github_pat_testtoken123");
  });

  test("an App that cannot mint a token fails the identity check", async () => {
    const w = await fakeWorld();
    const fetch = (async () => new Response("no", { status: 404 })) as unknown as typeof globalThis.fetch;
    const key = join(w.home, "missing.pem");
    const r = await runDoctor({ cwd: w.repo, env: { ...w.env, BUNKER_APP_ID: "1", BUNKER_APP_PRIVATE_KEY_PATH: key }, fetch });
    const c = r.checks.find((c) => c.id === "identity")!;
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("BUNKER_APP_ID");
  });
});

describe("doctor services", () => {
  test("declared services are listed and their images checked", async () => {
    const w = await fakeWorld({ files: {} });
    await Bun.write(join(w.repo, ".bunker/config.toml"), 'verify = "bun test"\n[services.database]\nimage = "postgres:18"\nhealthcheck = "pg_isready"\n');
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    const c = r.checks.find((c) => c.id === "service-database");
    expect(c).toMatchObject({ ok: true, label: "service database" });
    expect(c?.detail).toContain("postgres:18");
    expect(await w.log()).toContain("docker image inspect postgres:18");
    expect(formatChecks(r.checks)).toContain("service database: postgres:18");
  });
});

describe("doctor agent firewall", () => {
  const setup = async (iptables: string) => {
    const w = await fakeWorld();
    const bin = join(w.root, "bin");
    await Bun.write(join(bin, "docker"), `#!/bin/bash\ncase "$*" in "network inspect"*) printf "0123456789abcdef\nfd00::/64 fd00::1\n172.20.0.0/16 172.20.0.1\n";; esac\nexit 0\n`);
    await Bun.write(join(bin, "iptables"), `#!/bin/bash\n${iptables}\n`);
    await Bun.$`chmod +x ${join(bin, "docker")} ${join(bin, "iptables")}`;
    return w;
  };

  test("unprotected bridge: optional ✗ with the rules to install", async () => {
    const w = await setup("exit 0");
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    const c = r.checks.find((c) => c.id === "agent-firewall")!;
    expect(c.ok).toBe(false);
    expect(c.required).toBe(false);
    expect(c.fix).toContain("iptables -I DOCKER-USER -i br-0123456789ab -d 192.168.0.0/16 -j REJECT");
    expect(r.code).toBe(0);
  });

  test("rules in place: ✓", async () => {
    const w = await setup(`case "$2" in DOCKER-USER) for d in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do echo "-A DOCKER-USER -d $d -i br-0123456789ab -j REJECT"; done; echo "-A DOCKER-USER -i br-0123456789ab -j REJECT";; INPUT) echo "-A INPUT -i br-0123456789ab -m conntrack --ctstate NEW -j REJECT";; esac`);
    const r = await runDoctor({ cwd: w.repo, env: w.env });
    expect(r.checks.find((c) => c.id === "agent-firewall")?.ok).toBe(true);
  });
});
