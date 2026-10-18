import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServices, unpullable } from "../src/sandboxes/services.ts";
import { docker } from "../src/index.ts";
import { runVerify } from "../src/pipeline/steps/verify.ts";
import type { Sandbox } from "../src/sandboxes/exec.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fake container CLI logging one line per call; `fail` is a regex of call lines that exit 1. */
async function fakeBin(fail = "^$") {
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakesvc-"));
  dirs.push(dir);
  const bin = join(dir, "docker");
  await writeFile(bin, `#!/bin/sh\necho "$*" >> "${dir}/log"\necho "$*" | grep -Eq '${fail}' && exit 1\nexit 0\n`);
  await chmod(bin, 0o755);
  const log = async () => (await readFile(join(dir, "log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { bin, dir, log };
}

test("startServices makes an internal network, starts each service under its name, and stop removes them", async () => {
  const { bin, log } = await fakeBin();
  const set = await startServices(bin, { database: { image: "postgres:18", env: { POSTGRES_PASSWORD: "pw" }, healthcheck: "pg_isready" }, cache: { image: "redis:7" } });
  const calls = await log();
  expect(calls[0]).toBe(`network create --internal ${set.network}`);
  const dbRun = calls.find((c) => c.startsWith("run") && c.includes("postgres:18"))!;
  expect(dbRun).toContain(`--network ${set.network}`);
  expect(dbRun).toContain("--network-alias database");
  expect(dbRun).toContain("-e POSTGRES_PASSWORD=pw");
  expect(calls.some((c) => c.startsWith("run") && c.includes("--network-alias cache"))).toBe(true);
  expect(calls.some((c) => /^exec bunker-svc-\S+-database sh -c pg_isready$/.test(c))).toBe(true);
  expect(calls.some((c) => c.startsWith("exec") && c.includes("-cache"))).toBe(false); // no healthcheck: no wait
  await set.stop();
  await set.stop(); // idempotent
  const after = await log();
  expect(after.filter((c) => c.startsWith("rm -f"))).toHaveLength(2);
  expect(after.filter((c) => c === `network rm ${set.network}`)).toHaveLength(1);
});

test("two runs get their own network and container names", async () => {
  const { bin, log } = await fakeBin();
  const a = await startServices(bin, { database: { image: "pg" } });
  const b = await startServices(bin, { database: { image: "pg" } });
  expect(a.network).not.toBe(b.network);
  const names = (await log()).filter((c) => c.startsWith("run")).map((c) => /--name (\S+)/.exec(c)![1]);
  expect(new Set(names).size).toBe(2);
  await a.stop();
  await b.stop();
});

test("a service that never gets healthy is torn down and reported", async () => {
  const { bin, log } = await fakeBin("^exec");
  await expect(startServices(bin, { database: { image: "pg", healthcheck: "false" } }, { healthTimeoutMs: 50, healthIntervalMs: 10 })).rejects.toThrow("not healthy");
  const calls = await log();
  expect(calls.some((c) => c.startsWith("rm -f"))).toBe(true);
  expect(calls.some((c) => c.startsWith("network rm"))).toBe(true);
});

test("a service that fails to start removes what was started", async () => {
  const { bin, log } = await fakeBin("^run .*bad-image");
  await expect(startServices(bin, { a: { image: "pg" }, b: { image: "bad-image" } })).rejects.toThrow("service b");
  const calls = await log();
  expect(calls.filter((c) => c.startsWith("rm -f"))).toHaveLength(2);
  expect(calls.some((c) => c.startsWith("network rm"))).toBe(true);
});

test("unpullable lists images that can be neither found nor pulled", async () => {
  const { bin } = await fakeBin("^(image inspect|pull) .*nope");
  expect(await unpullable(bin, { a: { image: "pg" }, b: { image: "nope:1" } })).toEqual([{ name: "b", image: "nope:1", error: "" }]);
});

test("the container sandbox joins the service network instead of --network none", async () => {
  const { bin, dir, log } = await fakeBin();
  const sandbox = docker({ image: "img", bin });
  await sandbox.exec(["true"], { worktree: dir, gitCommonDir: join(dir, ".git"), isolate: true, network: "bunker-net-x" });
  await sandbox.exec(["true"], { worktree: dir, gitCommonDir: join(dir, ".git"), isolate: true });
  const runs = (await log()).filter((c) => c.startsWith("run"));
  expect(runs[0]).toContain("--network bunker-net-x");
  expect(runs[0]).not.toContain("--network none");
  expect(runs[1]).toContain("--network none");
});

// --- verify step ---

function ctx() {
  const notes: string[] = [];
  return {
    ctx: {
      worktree: "/w", gitCommonDir: "/w/.git", onEvent: undefined, timeouts: {}, log: () => {},
      fail: (reason: string, extra: object) => ({ reason, ...extra }),
      failNote: (n: string) => notes.push(n),
    } as any,
    notes,
  };
}

function fakeSandbox(opts: { exitFor?: (cmd: string) => number; startFails?: boolean } = {}) {
  const events: string[] = [];
  const sandbox: Sandbox = {
    async startServices(services) {
      if (opts.startFails) throw new Error("service database did not start");
      events.push(`start ${Object.keys(services).join(",")}`);
      return { network: "net1", stop: async () => void events.push("stop") };
    },
    async exec(cmd, c) {
      const text = cmd[2]!;
      events.push(`exec ${text} net=${c.network ?? "-"} isolate=${c.isolate}`);
      return { code: opts.exitFor?.(text) ?? 0, stdout: "out" };
    },
  };
  return { sandbox, events };
}

const input = (sandbox: Sandbox, more: object = {}) => ({ verify: "run-tests", verifyOnHost: false, verifyNetwork: false, setup: undefined, sandbox, result: {} as any, services: { database: { image: "pg" } }, prepare: "migrate", ...more });

test("verify starts services, runs prepare then verify on their network, and stops them", async () => {
  const { sandbox, events } = fakeSandbox();
  const { ctx: c } = ctx();
  expect(await runVerify(c, input(sandbox))).toBeUndefined();
  expect(events).toEqual(["start database", "exec (migrate) 2>&1 net=net1 isolate=true", "exec (run-tests) 2>&1 net=net1 isolate=true", "stop"]);
});

test("services are stopped when verify fails, and verify is skipped when prepare fails", async () => {
  const failing = fakeSandbox({ exitFor: (t) => (t.includes("run-tests") ? 1 : 0) });
  const r1: any = await runVerify(ctx().ctx, input(failing.sandbox));
  expect(r1.reason).toBe("verify-failed");
  expect(failing.events.at(-1)).toBe("stop");

  const prep = fakeSandbox({ exitFor: (t) => (t.includes("migrate") ? 2 : 0) });
  const r2: any = await runVerify(ctx().ctx, input(prep.sandbox));
  expect(r2.reason).toBe("failed");
  expect(r2.error).toContain("prepare failed (exit 2)");
  expect(prep.events.some((e) => e.includes("run-tests"))).toBe(false);
  expect(prep.events.at(-1)).toBe("stop");
});

test("each verify attempt gets fresh services", async () => {
  let n = 0;
  const { sandbox, events } = fakeSandbox({ exitFor: (t) => (t.includes("run-tests") && n++ === 0 ? 1 : 0) });
  const c = ctx().ctx;
  const r = await runVerify(c, input(sandbox, { retries: 1, fixRound: async () => undefined }));
  expect(r).toBeUndefined();
  expect(events.filter((e) => e.startsWith("start"))).toHaveLength(2);
  expect(events.filter((e) => e === "stop")).toHaveLength(2);
});

test("a service that won't start fails the run without running verify", async () => {
  const { sandbox, events } = fakeSandbox({ startFails: true });
  const r: any = await runVerify(ctx().ctx, input(sandbox));
  expect(r.reason).toBe("failed");
  expect(r.error).toContain("did not start");
  expect(events).toEqual([]);
});

test("services need a container sandbox and exclude --verify-on-host", async () => {
  const bare: Sandbox = { exec: async () => ({ code: 0, stdout: "" }) };
  const r1: any = await runVerify(ctx().ctx, input(bare));
  expect(r1.error).toContain("docker or podman");
  const r2: any = await runVerify(ctx().ctx, input(fakeSandbox().sandbox, { verifyOnHost: true }));
  expect(r2.error).toContain("--verify-on-host");
});
