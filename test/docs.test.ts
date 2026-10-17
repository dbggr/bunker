import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { readdirSync } from "node:fs";
import { cliDoc } from "../scripts/cli-docs.ts";
import { HELP } from "../src/help.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const root = import.meta.dir + "/..";
const docs = ["getting-started", "concepts", "security", "troubleshooting", "cli"].map((n) => `docs/${n}.md`);
const read = (p: string) => Bun.file(`${root}/${p}`).text();

describe("docs", () => {
  test("docs/cli.md is up to date with --help (run `bun run docs:cli`)", async () => {
    const help = Bun.spawnSync(["bun", "src/cli.ts", "--help"], { cwd: root }).stdout.toString();
    expect(help.trimEnd()).toBe(HELP.trimEnd());
    expect(await read("docs/cli.md")).toBe(cliDoc());
  });

  test("every doc exists and the README links to all of them", async () => {
    const readme = await read("README.md");
    for (const d of docs) {
      expect((await read(d)).length).toBeGreaterThan(200);
      expect(readme).toContain(d);
    }
    expect(readdirSync(`${root}/docs`).sort()).toEqual(docs.map((d) => d.slice(5)).sort());
  });

  test("every flag shown in the docs and README exists in --help", async () => {
    const known = new Set(HELP.match(/--[a-z][a-z-]*/g));
    for (const f of [...docs, "README.md"]) {
      for (const flag of new Set((await read(f)).match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [])) {
        if (!known.has(flag)) throw new Error(`${f} mentions ${flag}, which is not in --help`);
      }
    }
  });

  test("every `bun run <script>` in the docs is a package.json script", async () => {
    const scripts = Object.keys(JSON.parse(await read("package.json")).scripts);
    for (const f of [...docs, "README.md"]) {
      for (const m of (await read(f)).matchAll(/bun run ([\w:-]+)/g)) {
        if (!scripts.includes(m[1]!)) throw new Error(`${f}: bun run ${m[1]} is not a script`);
      }
    }
  });

  test("README has no flag tables and stays short", async () => {
    const readme = await read("README.md");
    expect(readme).not.toMatch(/^\|.*--[a-z]/m);
    expect(readme.split("\n").length).toBeLessThan(60);
  });
});
