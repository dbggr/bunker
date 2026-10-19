import { expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeMissing, missingHunks } from "../src/pipeline/landing.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

async function repoWith(squash: (text: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "bunker-landing-"));
  const git = (...a: string[]) => $`git -C ${dir} ${a}`.quiet();
  await $`git init -q -b main ${dir}`;
  await git("config", "user.name", "T");
  await git("config", "user.email", "t@example.com");
  const write = (l: string[]) => Bun.write(join(dir, "f.txt"), l.join("\n") + "\n");
  await write(lines);
  await git("add", ".");
  await git("commit", "-qm", "base");
  const base = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  await git("checkout", "-qb", "pr");
  await write(["A", ...lines.slice(1), "pr-end"]);
  await git("commit", "-qam", "pr");
  const head = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  await git("checkout", "-q", "main");
  await write(lines.map((l) => (l === "e" ? "E-main" : l)));
  await git("commit", "-qam", "other");
  await git("merge", "-q", "--squash", "pr");
  await Bun.write(join(dir, "f.txt"), squash(await Bun.file(join(dir, "f.txt")).text()));
  await git("commit", "-qam", "squash");
  return { dir, base, head };
}

test("main's own change to the same file is not a missing hunk", async () => {
  const { dir, base, head } = await repoWith((t) => t);
  expect(await missingHunks(dir, base, head, "HEAD")).toEqual([]);
});

test("a dropped hunk is reported with its header and lines", async () => {
  const { dir, base, head } = await repoWith((t) => t.replace("pr-end\n", ""));
  const r = await missingHunks(dir, base, head, "HEAD");
  expect(r).toEqual([{ file: "f.txt", header: "@@ -10,0 +11 @@", lines: ["pr-end"] }]);
  expect(describeMissing("HEAD", r as any)).toContain("f.txt @@ -10,0 +11 @@\n  + pr-end");
});
