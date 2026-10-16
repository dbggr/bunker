import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAuth, loadBunkerEnv, loadEnvFile } from "../src/env.ts";

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

describe("loadBunkerEnv", () => {
  test("loads the user file at ~/.config/bunker/.env", async () => {
    const home = await tempDir();
    await Bun.write(join(home, ".config/bunker/.env"), "CLAUDE_CODE_OAUTH_TOKEN=user\n");
    const env: Record<string, string | undefined> = { HOME: home };

    await loadBunkerEnv(await tempDir(), env);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("user");
  });

  test("respects XDG_CONFIG_HOME", async () => {
    const xdg = await tempDir();
    await Bun.write(join(xdg, "bunker/.env"), "CLAUDE_CODE_OAUTH_TOKEN=xdg\n");
    const env: Record<string, string | undefined> = { HOME: await tempDir(), XDG_CONFIG_HOME: xdg };

    await loadBunkerEnv(await tempDir(), env);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("xdg");
  });

  test("exported env > repo .bunker/.env > user file", async () => {
    const home = await tempDir();
    const repo = await tempDir();
    await Bun.write(join(home, ".config/bunker/.env"), "A=user\nB=user\nC=user\n");
    await Bun.write(join(repo, ".bunker/.env"), "A=repo\nB=repo\n");
    const env: Record<string, string | undefined> = { HOME: home, A: "shell" };

    await loadBunkerEnv(repo, env);

    expect([env.A, env.B, env.C]).toEqual(["shell", "repo", "user"]);
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
  // Empty HOME so a real ~/.config/bunker/.env on the dev box cannot leak into these tests.
  const bareEnv = { PATH: process.env.PATH ?? "", HOME: join(tmpdir(), "bunker-test-empty-home") };

  test("without auth, exits non-zero and points at claude setup-token", async () => {
    const repo = await tempDir();
    await $`git init -q ${repo}`;

    const proc = Bun.spawn(["bun", cli, "do a thing"], { cwd: repo, env: bareEnv, stderr: "pipe" });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("claude setup-token");
  });

  test("picks the token up from the user file, with no repo .env", async () => {
    const repo = await tempDir();
    const home = await tempDir();
    await $`git init -q ${repo}`;
    await Bun.write(join(home, ".config/bunker/.env"), "CLAUDE_CODE_OAUTH_TOKEN=tok\n");

    const proc = Bun.spawn(["bun", cli, "--image", "bunker-no-such-image", "x"], {
      cwd: repo,
      env: { ...bareEnv, HOME: home },
      stderr: "pipe",
    });
    expect(await proc.exited).not.toBe(2);

    expect(await new Response(proc.stderr).text()).not.toContain("claude setup-token");
  }, 30_000);

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

  test("--merge without --verify is left for runIssue to judge, not pre-checked locally", async () => {
    const repo = await tempDir();
    await $`git init -q ${repo}`;

    const proc = Bun.spawn(["bun", cli, "--issue", "1", "--merge"], { cwd: repo, env: bareEnv, stderr: "pipe" });

    await proc.exited;
    expect(await new Response(proc.stderr).text()).not.toContain("--merge requires");
  }, 30_000);

  test("a local-only .bunker/verify file does not change the CLI's decision", async () => {
    const repo = await tempDir();
    await $`git init -q ${repo}`;
    await $`mkdir -p ${repo}/.bunker`;
    await Bun.write(`${repo}/.bunker/verify`, "true\n");

    const proc = Bun.spawn(["bun", cli, "--queue", "--merge"], { cwd: repo, env: bareEnv, stderr: "pipe" });

    await proc.exited;
    expect(await new Response(proc.stderr).text()).not.toContain("--merge requires");
  }, 30_000);

  test("a positional prompt together with --task exits 2 and prints usage", async () => {
    const repo = await tempDir();
    await $`git init -q ${repo}`;

    const proc = Bun.spawn(["bun", cli, "--task", "a thing", "do a thing"], {
      cwd: repo,
      env: bareEnv,
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("--task");
  });
});
