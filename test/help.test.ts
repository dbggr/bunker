import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { options } from "../src/options.ts";

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
      for (const name of Object.keys(options)) expect(r.out).toContain(`--${name}`);
      for (const s of ["--version", "CLAUDE_CODE_OAUTH_TOKEN", "BUNKER_GH_TOKEN", ".bunker/.env", "Examples"]) expect(r.out).toContain(s);
      expect(r.out).toContain('bunker --queue --verify "bun test && bun run typecheck" --merge');
    });
    test(`${flag} wins over other flags`, () => {
      const r = cli("--queue", "--merge", "--bogus", flag);
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
    expect(cli("--issue", "1", "--port", "4000").code).toBe(2);
    expect(cli("--issue", "1", "--ui-keep").code).toBe(2);
    expect(cli("--ui", "do a thing").code).toBe(2);
    expect(cli("--issue", "1", "--ui", "--port", "nope").code).toBe(2);
  });
  test("bunker ui takes only --port", () => {
    expect(cli("ui", "--port", "nope").code).toBe(2);
    expect(cli("ui", "--issue", "1").code).toBe(2);
    expect(cli("--help").out).toContain("bunker ui [--port <n>]");
  });
});

describe("reserved one-word prompts", () => {
  for (const word of ["init", "doctor"]) {
    test(`${word} is a subcommand, but -- ${word} is a prompt`, () => {
      expect(cli("--watch", word).err).toContain(`${word} only takes`);
      expect(cli("--watch", "--", word).err).toContain("can't be combined with a prompt");
    });
  }
  test("help documents the -- escape", () => {
    expect(cli("--help").out).toContain("bunker -- init");
  });
});
