import { beforeEach, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { output } from "../src/core/output.ts";

// Tests spawn many git/gh processes; Bun's 5s default is exceeded on a loaded host (CI, or a suite run beside others,
// e.g. a parallel bunker verify). A timed-out test leaves its work running, which then races the next test's temp dirs
// and PATH, so one slow test cascades into unrelated failures. Bun applies a preload's default only to the first test
// file, so every test file repeats this call (test/timeout.test.ts checks they do).
setDefaultTimeout(60_000);

// Fake agents print <issue> blocks and text; keep that out of `bun test`'s own output.
beforeEach(() => {
  output.verbose = false;
  output.write = () => true;
  output.warn = () => {};
});

// Git's detached auto-maintenance (after commit, fetch, ...) is orphaned when the test exits; on a host whose PID 1
// doesn't reap, those pile up as zombies. Disable it for every git the tests spawn (appending to any existing
// GIT_CONFIG_* entries).
const gitConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
for (const [i, [key, value]] of [["maintenance.auto", "false"], ["gc.auto", "0"]].entries()) {
  process.env[`GIT_CONFIG_KEY_${gitConfigCount + i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${gitConfigCount + i}`] = value;
}
process.env.GIT_CONFIG_COUNT = String(gitConfigCount + 2);

// Bun.spawn/spawnSync hand children the environment from process start, not the live process.env edited above,
// so default their env to the current process.env.
const realSpawn = Bun.spawn;
const realSpawnSync = Bun.spawnSync;
const withEnv = (args: any[]) => {
  const optsIndex = Array.isArray(args[0]) ? 1 : 0;
  const opts = args[optsIndex];
  if (opts?.env) return args;
  const next = [...args];
  next[optsIndex] = { ...opts, env: { ...process.env } };
  return next;
};
(Bun as any).spawn = (...args: any[]) => (realSpawn as any)(...withEnv(args));
(Bun as any).spawnSync = (...args: any[]) => (realSpawnSync as any)(...withEnv(args));

// A `bunker --watch` run in a test subprocess would pop real desktop notifications (spend cap, failed, stopped) on a
// developer's machine; the CLI skips the desktop notifier when this is set (children inherit it from process.env).
process.env.BUNKER_TEST_NO_NOTIFY = "1";

// Tests must never reach the real Docker daemon, desktop notifier or network. Fakes go first on PATH; any test that
// puts its own fake earlier still wins. Tests that need real Docker opt in with BUNKER_TEST_REAL_DOCKER=1 (and
// `describe.skipIf(!dockerUp)`, touching only `bunker-test-` images); test/hygiene.test.ts checks the fakes are in place.
if (process.env.BUNKER_TEST_REAL_DOCKER !== "1") {
  const fakeBin = join(tmpdir(), `bunker-test-fakebin-${process.pid}`);
  mkdirSync(fakeBin, { recursive: true });
  const refuse = (name: string) => `#!/bin/sh\necho "${name} $*: tests must not reach the real ${name}" >&2\nexit 97\n`;
  for (const name of ["docker", "podman", "notify-send", "osascript", "curl", "wget"]) {
    writeFileSync(join(fakeBin, name), refuse(name));
    chmodSync(join(fakeBin, name), 0o755);
  }
  process.env.BUNKER_TEST_FAKE_BIN = fakeBin;
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
  process.on("exit", () => rmSync(fakeBin, { recursive: true, force: true }));
}

// Verify itself runs inside a bunker sandbox, where BUNKER_IN_SANDBOX=1 makes every CLI the tests spawn refuse to start.
// The guard's own test (test/sandbox-guard.test.ts) sets it explicitly.
delete process.env.BUNKER_IN_SANDBOX;

// The CLI reads ~/.config/bunker/{.env,config.toml}; a developer's real one (BUNKER_APP_ID, caps, labelers) would leak
// into tests and fail them locally while CI stays green. Point the config dir at an empty temp dir for every test.
// test/hygiene.test.ts checks this.
const configHome = mkdtempSync(join(tmpdir(), "bunker-test-config-"));
process.env.XDG_CONFIG_HOME = configHome;
process.on("exit", () => rmSync(configHome, { recursive: true, force: true }));

// `bunker watch` in a test subprocess publishes to any hub reachable on the default port, which is a developer's live
// `bunker ui` (phantom bunker-watch-*/origin tabs). Point the default at a port nothing listens on (dynamic range,
// picked per run). test/hygiene.test.ts checks this.
process.env.BUNKER_HUB_PORT = String(40000 + (process.pid % 20000));

// Most container tests use a fake docker with no network gateway to put the egress proxy on (test/egress.test.ts turns it back on).
process.env.BUNKER_EGRESS_PROXY = "off";
