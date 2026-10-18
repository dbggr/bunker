import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { options } from "../src/core/options.ts";
import { MODES } from "../src/cli/modes.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const cli = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-test-token-0123456789" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

describe("--help", () => {
  for (const flag of ["--help", "-h"]) {
    test(`${flag} prints full help and exits 0`, () => {
      const r = cli(flag);
      expect(r.code).toBe(0);
      const removed = ["issue", "queue", "watch", "audit", "review", "task"]; // the old mode flags parse only to report their replacement
      for (const name of Object.keys(options).filter((n) => !removed.includes(n))) expect(r.out).toContain(`--${name}`);
      for (const s of ["--version", "CLAUDE_CODE_OAUTH_TOKEN", "BUNKER_GH_TOKEN", ".bunker/.env", "Examples"]) expect(r.out).toContain(s);
      expect(r.out).toContain('bunker queue --verify "bun test && bun run typecheck" --merge');
    });
    test(`${flag} wins over other flags`, () => {
      const r = cli("queue", "--merge", "--bogus", flag);
      expect(r.code).toBe(0);
      expect(r.out).toContain("--max-rounds");
    });
  }
  test("documents defaults", () => {
    const { out } = cli("--help");
    expect(out).toMatch(/--max-rounds <n>.*default 2/);
    expect(out).toMatch(/--ci-timeout <min>.*default 30/);
    expect(out).toMatch(/--limit <n>.*default 5/);
  });
});

describe("bad input", () => {
  test("unknown option exits 2 without a stack trace", () => {
    const r = cli("--x", "hi");
    expect(r.code).toBe(2);
    expect(r.err).toContain("bunker: unknown option --x");
    expect(r.err).toContain("see bunker --help");
    expect(r.err).not.toMatch(/\n\s+at /);
  });
  test("short usage points at --help", () => {
    const r = cli();
    expect(r.code).toBe(2);
    expect(r.err).toContain("run bunker --help for all options");
  });
});

describe("--ui flags", () => {
  test("--ui-keep, --port need --ui; --ui needs a run mode", () => {
    expect(cli("issue", "1", "--port", "4000").code).toBe(2);
    expect(cli("issue", "1", "--ui-keep").code).toBe(2);
    expect(cli("--ui", "do a thing").code).toBe(2);
    expect(cli("issue", "1", "--ui", "--port", "nope").code).toBe(2);
  });
  test("bunker ui takes only --port", () => {
    expect(cli("ui", "--port", "nope").code).toBe(2);
    expect(cli("ui", "--limit", "1").code).toBe(2);
    expect(cli("--help").out).toContain("bunker ui [--port <n>]");
  });
});

describe("subcommands", () => {
  test("bunker --help lists every mode as a word", () => {
    const { out } = cli("--help");
    for (const m of MODES) expect(out).toMatch(new RegExp(`^  bunker ${m} `, "m"));
  });
  test("<cmd> --help shows only that command's options", () => {
    const watch = cli("watch", "--help");
    expect(watch.code).toBe(0);
    expect(watch.out).toContain("--interval <min>");
    expect(watch.out).not.toContain("--focus");
    expect(watch.out).not.toContain("--max-iterations");
    const audit = cli("audit", "--help");
    expect(audit.out).toContain("--focus");
    expect(audit.out).not.toContain("--interval");
    for (const m of MODES) expect(cli(m, "--help").out).toContain(`bunker ${m}`);
  });
  const REPLACEMENTS: [string[], string][] = [
    [["--watch"], "watch"], [["--queue"], "queue"], [["--audit"], "audit"], [["--review", "x"], "review"], [["--task", "x"], "task"], [["--issue", "7"], "issue <n>"],
  ];
  for (const [args, cmd] of REPLACEMENTS) {
    test(`${args[0]} was replaced by \`bunker ${cmd}\``, () => {
      const r = cli(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`bunker: ${args[0]} was replaced by \`bunker ${cmd}\``);
    });
  }
  test("an option from another command names the subcommand", () => {
    for (const [args, flag, cmd] of [
      [["issue", "1", "--limit", "2"], "--limit", "issue"],
      [["queue", "--interval", "1"], "--interval", "queue"],
      [["audit", "--merge"], "--merge", "audit"],
      [["watch", "--focus", "x"], "--focus", "watch"],
      [["review", "x", "--verify", "true"], "--verify", "review"],
      [["task", "x", "--yes"], "--yes", "task"],
      [["--yes", "do it"], "--yes", "bunker \"<prompt>\""],
    ] as [string[], string, string][]) {
      const r = cli(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`${flag} doesn't apply to ${cmd.startsWith("bunker") ? cmd : `bunker ${cmd}`}`);
    }
  });
  test("missing or surplus arguments exit 2", () => {
    expect(cli("issue").err).toContain("issue takes one issue number");
    expect(cli("queue", "7").err).toContain("queue takes no arguments");
    expect(cli("review").err).toContain("review needs a prompt");
    expect(cli("task").err).toContain("task needs a prompt");
  });
  test("every mode runs through its subcommand", () => {
    // Each gets past option checks and fails on something later (a bad issue number, no verify command, no repo config, …).
    expect(cli("issue", "0", "--no-pull", "--no-sandbox").err).toContain("issue number must be a positive integer");
    expect(cli("watch", "--max-cost", "1", "--max-cost-day", "1", "--no-sandbox").err).toContain("--max-cost is an alias");
    for (const args of [["queue", "--limit", "0"], ["audit", "--max-issues", "0"]]) expect(cli(...args, "--no-sandbox").err).toContain("must be a positive integer");
    expect(cli("review", "x", "--max-rounds", "0", "--no-sandbox").err).toContain("--max-rounds must be a positive integer");
    expect(cli("task", "x", "y", "--max-iterations", "0", "--no-sandbox").err).toContain("--max-iterations must be a positive integer");
  });
});

describe("reserved one-word prompts", () => {
  for (const word of ["init", "doctor"]) {
    test(`${word} is a subcommand, but -- ${word} is a prompt`, () => {
      expect(cli("--limit", "3", word).err).toContain(`${word} only takes`);
      expect(cli("--limit", "3", "--", word).err).toContain('doesn\'t apply to bunker "<prompt>"');
    });
  }
  test("help documents the -- escape", () => {
    expect(cli("--help").out).toContain("bunker -- init");
  });
});
