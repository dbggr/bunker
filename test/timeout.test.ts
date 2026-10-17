import { expect, setDefaultTimeout, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

setDefaultTimeout(60_000); // see test/setup.ts

test("every test file sets the load-proof default timeout (Bun applies the preload's only to the first file)", async () => {
  const missing: string[] = [];
  for await (const file of new Glob("*.test.ts").scan(import.meta.dir)) {
    if (!/^setDefaultTimeout\(60_000\);/m.test(await Bun.file(join(import.meta.dir, file)).text())) missing.push(file);
  }
  expect(missing).toEqual([]);
});
