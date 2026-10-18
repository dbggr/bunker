import { expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000); // see test/setup.ts

test("the library's public export list is pinned: additions and removals are deliberate", async () => {
  const api = await import("../src/index.ts");
  expect(Object.keys(api).sort()).toEqual(["AgentFailure", "UsageLimit", "claudeCode", "docker", "noSandbox", "podman", "review", "run", "runAll"]);
});

test("docs/library-api section exists in concepts", async () => {
  expect(await Bun.file(import.meta.dir + "/../docs/concepts.md").text()).toContain("## Library API");
});
