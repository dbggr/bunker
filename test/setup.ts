import { beforeEach, setDefaultTimeout } from "bun:test";
import { output } from "../src/output.ts";

// Tests spawn many git/gh processes; Bun's 5s default is exceeded on a loaded host (CI, or a suite run beside others,
// e.g. a parallel bunker verify). A timed-out test leaves its work running, which then races the next test's temp dirs
// and PATH, so one slow test cascades into unrelated failures. Bun applies a preload's default only to the first test
// file, so every test file repeats this call (test/timeout.test.ts checks they do).
setDefaultTimeout(60_000);

// Fake agents print <issue> blocks and text; keep that out of `bun test`'s own output.
beforeEach(() => {
  output.verbose = false;
  output.write = () => true;
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
