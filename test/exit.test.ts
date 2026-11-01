import { expect, test, setDefaultTimeout } from "bun:test";
import { exitLabel } from "../src/core/exit.ts";

setDefaultTimeout(60_000); // see test/setup.ts
import { reasonFromLog } from "../src/core/reason.ts";

test("exitLabel names the signal for codes >= 128", () => {
  expect(exitLabel(1)).toBe("1");
  expect(exitLabel(127)).toBe("127");
  expect(exitLabel(139)).toBe("139 (SIGSEGV)");
  expect(exitLabel(137)).toBe("137 (SIGKILL)");
  expect(exitLabel(143)).toBe("143 (SIGTERM)");
  expect(exitLabel(128 + 40)).toBe("168 (signal 40)");
});

test("the failure reason keeps the step label and signal from the error", () => {
  const error = `implementer round 2 failed: agent exited with ${exitLabel(139)}; work kept on feature/1-x`;
  expect(reasonFromLog("failed", "", { error })).toBe("implementer round 2 failed: agent exited with 139 (SIGSEGV); work kept on feature/1-x");
});

import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, review, type Agent } from "../src/index.ts";

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-exit-"));
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

const commit = `N=$(git rev-list --count HEAD); echo $N > f$N.txt && git add . && git commit -qm "impl $N"`;
const APPROVE = '<verdict>{"approved":true,"required_changes":[]}</verdict>';
const CHANGES = '<verdict>{"approved":false,"required_changes":["more"]}</verdict>';

async function failing(write: (n: number) => string, rev: (n: number) => string, setup?: string) {
  const dir = await repo();
  let w = 0, r = 0;
  const agent: Agent = { command: (_p, mode = "write") => ["sh", "-c", mode === "write" ? write(++w) : rev(++r)] };
  try {
    return await review({ cwd: dir, prompt: "x", agent, sandbox: noSandbox(), maxRounds: 3, ...(setup ? { setup } : {}) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("setup failure names setup and the signal", async () => {
  const r = await failing(() => commit, () => `echo '${APPROVE}'`, "kill -SEGV $$");
  expect(r.failedStep).toBe("setup");
  expect(r.error).toContain("setup failed (exit 139 (SIGSEGV))");
});

test("implementer failure in round 2 names the role and round", async () => {
  const r = await failing((n) => (n === 1 ? commit : "kill -SEGV $$"), () => `echo '${CHANGES}'`);
  expect(r.status).toBe("failed");
  expect(r.failedStep).toBe("implementer round 2");
  expect(r.error).toContain("implementer round 2 failed: agent exited with 139 (SIGSEGV)");
});

test("reviewer failure names the reviewer and round", async () => {
  const r = await failing(() => commit, () => "kill -SEGV $$");
  expect(r.failedStep).toBe("reviewer round 1");
  expect(r.error).toContain("reviewer round 1 failed: reviewer exited with 139 (SIGSEGV)");
});
