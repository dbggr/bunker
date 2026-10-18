import { beforeEach, setDefaultTimeout } from "bun:test";
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
