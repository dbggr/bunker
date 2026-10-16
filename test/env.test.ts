import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAuth, loadEnvFile } from "../src/env.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-env-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("loadEnvFile", () => {
  test("sets KEY=VALUE pairs and skips comments and blank lines", async () => {
    const file = join(await tempDir(), ".env");
    await Bun.write(file, "# claude setup-token\nCLAUDE_CODE_OAUTH_TOKEN=tok-123\n\n# ANTHROPIC_API_KEY=sk\n");
    const env: Record<string, string | undefined> = {};

    await loadEnvFile(file, env);

    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok-123" });
  });

  test("strips matching quotes and keeps '=' inside values", async () => {
    const file = join(await tempDir(), ".env");
    await Bun.write(file, `A="x=y"\nB='q'\n`);
    const env: Record<string, string | undefined> = {};

    await loadEnvFile(file, env);

    expect(env).toEqual({ A: "x=y", B: "q" });
  });

  test("the real environment wins over the file", async () => {
    const file = join(await tempDir(), ".env");
    await Bun.write(file, "CLAUDE_CODE_OAUTH_TOKEN=from-file\n");
    const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: "from-shell" };

    await loadEnvFile(file, env);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("from-shell");
  });

  test("a missing file is not an error", async () => {
    const env: Record<string, string | undefined> = {};
    await loadEnvFile(join(await tempDir(), "nope"), env);
    expect(env).toEqual({});
  });
});

describe("hasAuth", () => {
  test("accepts either the OAuth token or an API key, ignoring empty values", () => {
    expect(hasAuth({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe(true);
    expect(hasAuth({ ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(hasAuth({ CLAUDE_CODE_OAUTH_TOKEN: "" })).toBe(false);
    expect(hasAuth({})).toBe(false);
  });
});

describe("cli", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const bareEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

  test("without auth, exits non-zero and points at claude setup-token", async () => {
    const repo = await tempDir();
    await $`git init -q ${repo}`;

    const proc = Bun.spawn(["bun", cli, "do a thing"], { cwd: repo, env: bareEnv, stderr: "pipe" });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("claude setup-token");
  });

  test("picks the token up from <repo>/.bunker/.env", async () => {
    const repo = await tempDir();
    await $`git init -q ${repo}`;
    await Bun.write(join(repo, ".bunker/.env"), "CLAUDE_CODE_OAUTH_TOKEN=tok\n");

    // Auth passes; the run then fails fast (empty repo, missing image) without reaching claude.
    const proc = Bun.spawn(["bun", cli, "--image", "bunker-no-such-image", "x"], {
      cwd: repo,
      env: bareEnv,
      stderr: "pipe",
    });
    expect(await proc.exited).not.toBe(2);

    expect(await new Response(proc.stderr).text()).not.toContain("claude setup-token");
  }, 30_000);
});
