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
