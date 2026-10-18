import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { sandboxDryRun } from "../src/cli/init/dry-run.ts";
import type { Sandbox } from "../src/sandboxes/exec.ts";
import { cleanup, fakeWorld } from "./fakes.ts";

setDefaultTimeout(60_000);
afterEach(cleanup);

async function run(o: { prepare?: string; failPrepare?: boolean }) {
  const w = await fakeWorld();
  await $`git -C ${w.repo} add -A && git -C ${w.repo} -c user.name=t -c user.email=t@e commit -q -m init --allow-empty`;
  const events: string[] = [];
  const sandbox: Sandbox = {
    startServices: async (s) => (events.push(`start ${Object.keys(s)}`), { network: "net1", stop: async () => void events.push("stop") }),
    exec: async (cmd, ctx) => {
      events.push(`${cmd[2]} net=${ctx.network}`);
      return o.failPrepare && cmd[2]!.includes("prep") ? { code: 3, stdout: "no db" } : { code: 0, stdout: "ok" };
    },
  };
  const r = await sandboxDryRun({ root: w.repo, env: w.env, sandbox, verify: "test-it", services: { database: { image: "pg" } }, ...(o.prepare ? { prepare: o.prepare } : {}) });
  return { r, events };
}

test("the dry run starts services, runs prepare and verify on their network, and removes them", async () => {
  const { r, events } = await run({ prepare: "prep" });
  expect(r.ok).toBe(true);
  expect(events).toEqual(["start database", "(prep) 2>&1 net=net1", "(test-it) 2>&1 net=net1", "stop"]);
});

test("a failing prepare is a verify-phase failure and the services are removed", async () => {
  const { r, events } = await run({ prepare: "prep", failPrepare: true });
  expect(r).toMatchObject({ ok: false, phase: "verify" });
  expect(r.tail).toContain("no db");
  expect(events.at(-1)).toBe("stop");
});
