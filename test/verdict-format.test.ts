import { test, expect, setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000); // see test/setup.ts

test("VERDICT_FORMAT has a space after 'Valid JSON,'", async () => {
  const src = await Bun.file(new URL("../src/pipeline/review.ts", import.meta.url)).text();
  expect(src).toContain("Valid JSON, `approved`");
  expect(src).not.toContain("Valid JSON,`approved`");
});
