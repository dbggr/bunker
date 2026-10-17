import { expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";

setDefaultTimeout(60_000); // see test/setup.ts

// Detached `git maintenance`/`gc --auto` processes outlive the suite and pile up as zombies on hosts without a
// reaping init, so the preload must switch them off for every git the tests spawn.
test("git spawned from tests has auto maintenance and gc disabled", async () => {
  const maintenance = (await $`git config --get maintenance.auto`.text()).trim();
  const gc = (await $`git config --get gc.auto`.text()).trim();
  expect(maintenance).toBe("false");
  expect(gc).toBe("0");
});

test("git spawned via Bun.spawn and Bun.spawnSync has maintenance and gc disabled", async () => {
  for (const [key, want] of [["maintenance.auto", "false"], ["gc.auto", "0"]] as const) {
    const cmd = ["git", "config", "--get", key];
    const proc = Bun.spawn(cmd, { stdout: "pipe" });
    expect((await new Response(proc.stdout).text()).trim()).toBe(want);
    expect(Bun.spawnSync(cmd).stdout.toString().trim()).toBe(want);
    expect(Bun.spawnSync({ cmd, stdout: "pipe" }).stdout.toString().trim()).toBe(want);
  }
});
