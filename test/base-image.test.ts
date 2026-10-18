import { expect, test, setDefaultTimeout } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseImage } from "../src/sandboxes/container.ts";

setDefaultTimeout(60_000); // see test/setup.ts

test("buildBaseImage pipes the embedded Dockerfile to `docker build -` on stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakedocker-"));
  await writeFile(join(dir, "docker"), `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin"\n`);
  await chmod(join(dir, "docker"), 0o755);
  await buildBaseImage("bunker-claude", join(dir, "docker"));
  expect((await readFile(join(dir, "args"), "utf8")).trim()).toBe("build -q -t bunker-claude -");
  expect(await readFile(join(dir, "stdin"), "utf8")).toBe(await Bun.file(join(import.meta.dir, "..", "images", "base", "Dockerfile")).text());
});
