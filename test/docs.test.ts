import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { readdirSync } from "node:fs";
import { cliDoc } from "../scripts/cli-docs.ts";
import { CONFIG_KEYS } from "../src/core/config.ts";
import { MODES } from "../src/cli/modes.ts";
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

  test("cli.md keeps every flag, config key and example of --help, as sectioned tables", async () => {
    const md = await read("docs/cli.md");
    for (const h of ["Setup", "Run work", "PRs", "Monitor", "Find work", "Maintenance", "Common flags", "Config keys", "Labels", "Examples"]) expect(md).toMatch(new RegExp(`^## ${h}$`, "m"));
    for (const m of MODES) expect(md).toMatch(new RegExp(`^### bunker (${m}|"&lt;prompt&gt;")$`, "m"));
    for (const flag of new Set(HELP.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [])) expect(md).toContain(flag);
    for (const k of CONFIG_KEYS) expect(md).toContain(`| ${k.key} | ${k.doc} |`);
    for (const l of HELP.slice(HELP.indexOf("\nExamples:")).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("bunker "))) expect(md).toContain(l);
    expect(md).not.toContain("```text");
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
    expect(readme.split("\n").length).toBeLessThan(75);
  });
});

describe("services docs (#411)", () => {
  test("concepts.md documents services, prepare and the trade-off; cli.md lists them", async () => {
    const [concepts, cli] = await Promise.all([read("docs/concepts.md"), read("docs/cli.md")]);
    for (const s of ["[services.database]", "prepare", "internal network", "Security trade-off", "throwaway"]) expect(concepts).toContain(s);
    for (const s of ["[services.<name>]", "healthcheck", "prepare "]) expect(cli).toContain(s);
  });

  test("the docs describe the hub's runs by state and its history files (#489)", async () => {
    const [concepts, sec, readme] = await Promise.all(["docs/concepts.md", "docs/security.md", "README.md"].map(read));
    expect(concepts).toContain("## Live view (`bunker ui`)");
    for (const s of ["Running", "Waiting for merge", "Finished today", "Queue", "Shepherd", "Watcher", "audit card", "XDG_STATE_HOME", "hub/<owner>_<repo>.jsonl", "2000", "7 days", "delete its file"]) expect(concepts).toContain(s);
    for (const s of ["XDG_STATE_HOME", "mode 600", "redacted"]) expect(sec).toContain(s);
    expect(readme).toContain("history across restarts");
  });

  test("bunker mcp is documented in the README and getting-started, and the site guide is built from docs/ (#506)", async () => {
    const [readme, start, prep] = await Promise.all(["README.md", "docs/getting-started.md", "site/scripts/prepare-docs.ts"].map(read));
    expect(readme).toContain("claude mcp add -s user bunker -- bunker mcp");
    expect(start).toContain("claude mcp add -s user bunker -- bunker mcp");
    for (const s of ["bunker-watch@", "list_watches", "invisible"]) expect(start).toContain(s);
    expect(prep).toContain('join(root, "docs")'); // site/guide mirrors docs/
  });
});

describe("good-fit guide (#523)", () => {
  test("concepts.md has the guide, links review_paths to security.md, and the README points to it", async () => {
    const [concepts, readme] = await Promise.all([read("docs/concepts.md"), read("README.md")]);
    expect(concepts).toMatch(/^## Is this a good fit for bunker\?$/m);
    const section = concepts.split(/^## Is this a good fit for bunker\?$/m)[1]!.split(/^## /m)[0]!;
    for (const s of ["Do it by hand", "Queue it", "review_paths", "(security.md)", "borderline"]) expect(section).toContain(s);
    expect(readme).toContain("docs/concepts.md#is-this-a-good-fit-for-bunker");
  });
});
