import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { readdirSync } from "node:fs";
import { cliDoc } from "../scripts/cli-docs.ts";
import { HELP } from "../src/cli/commands/help.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const root = import.meta.dir + "/..";
const docs = ["getting-started", "concepts", "security", "troubleshooting", "cli", "release"].map((n) => `docs/${n}.md`);
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
    const known = new Set([...(HELP.match(/--[a-z][a-z-]*/g) ?? []), "--name", "--yes", "--check", "--skip-runtime-check", "--ref", "--uninstall", "--network"]); // --name: `gh label edit` in the label migration; --network: the container's `--network host`; the rest: install.sh
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

  test("security.md covers the 2026-10-18 security fixes", async () => {
    const sec = await read("docs/security.md");
    for (const needle of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "verify_network", "re-add the label", "rulesets", "Administration", "getting-started.md#"]) {
      expect(sec).toContain(needle);
    }
    expect(sec).not.toContain("needs-human-review"); // no longer set; the label is bunker:review
    expect(sec).toContain("bunker:review");
  });

  test("the docs match main after the 2026-10-18 changes (#363)", async () => {
    const [concepts, sec, start, trouble, readme, how, v1] = await Promise.all(["docs/concepts.md", "docs/security.md", "docs/getting-started.md", "docs/troubleshooting.md", "README.md", "release/design/how-bunker-works.html", "release/v1-readiness.md"].map(read));
    for (const s of ["--network host", "verify_retries", "clean.logs_days", "awaiting-review", "paused-usage-limit", "already-in-progress", "bad-output", "read from origin's default branch"]) expect(concepts).toContain(s);
    expect(concepts).not.toContain("bunker never reads CI itself");
    expect(concepts).not.toContain("read from the worktree");
    for (const s of ["localhost", "only `.bunker/prompts/issue.md`", "`check`"]) expect(sec).toContain(s);
    for (const s of ["install.sh", "[clean]", "[notify]", "verify_network", "verify_retries", "context", "merge.mode"]) expect(start).toContain(s);
    expect(start).not.toContain("[queue]");
    expect(start).not.toContain("bun run build && install");
    expect(trouble).toContain("no required status check");
    expect(trouble).toContain("`verify-failed`");
    expect(trouble).not.toContain(".bunker/setup");
    for (const s of ["shepherd", "bunker status", "Manual-merge", "skills", "AGENTS.md"]) expect(readme).toContain(s);
    expect(readme).not.toMatch(/^- (prompt templating|host hooks)$/m);
    expect(how).not.toContain("your computer");
    expect(how).not.toContain("asks before changing");
    expect(v1).not.toContain("`--issue`/`--queue`");
    expect(v1).toContain("23 keys");
    expect(start).toContain("triage_every");
    expect(start).toContain("max_cost_month");
    expect(cliDoc()).toContain("watch.triage_every");
    expect(cliDoc()).toContain("max_cost_day");
  });

  test("README has no flag tables and stays short", async () => {
    const readme = await read("README.md");
    expect(readme).not.toMatch(/^\|.*--[a-z]/m);
    expect(readme.split("\n").length).toBeLessThan(65);
  });
});
