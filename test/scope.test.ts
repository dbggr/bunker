import { test, expect, setDefaultTimeout } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";


setDefaultTimeout(60_000); // see test/setup.ts
const root = join(import.meta.dir, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

test("src/ has no org- or repo-specific names", () => {
  const allowed = "@dbggr/bunker"; // the package name
  const hits: string[] = [];
  for (const f of files(join(root, "src"))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/dbggr|iac-github/i.test(line.split(allowed).join(""))) hits.push(`${f}:${i + 1}`);
    });
  }
  expect(hits).toEqual([]);
});

test("package is MIT licensed and LICENSE exists", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.license).toBe("MIT");
  expect(pkg.name).toBe("@dbggr/bunker");
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toMatch(/^MIT License/);
});

test("README has a Scope section", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  expect(readme).toMatch(/^## Scope$/m);
  expect(readme).toMatch(/npm publishing/);
});
