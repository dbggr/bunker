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
