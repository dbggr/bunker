import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "install.sh");
setDefaultTimeout(60_000); // see test/setup.ts
let root: string;
let home: string;
let fakes: string;
let origin: string;

const exe = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const release = (version: string) => {
  writeFileSync(join(origin, "package.json"), JSON.stringify({ version }));
  git(origin, "add", ".");
  git(origin, "commit", "-qm", `release ${version}`);
  git(origin, "tag", `v${version}`);
};

function run(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["sh", script, ...args], {
    env: {
      HOME: home,
      PATH: `${fakes}:/usr/bin:/bin`,
      BUNKER_REPO: origin,
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...env,
    },
    stdin: "ignore",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunker-install-"));
  home = join(root, "home");
  fakes = join(root, "fakes");
  origin = join(root, "origin");
  mkdirSync(home);
  mkdirSync(fakes);
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  release("1.0.0");
  exe(join(fakes, "git"), `exec ${Bun.which("git")} "$@"`);
  // fake bun: `bun run build` drops a "compiled" binary at dist/bunker
  exe(join(fakes, "bun"), `case "$1" in --version) echo 1.3.0;; run) mkdir -p dist; printf '#!/bin/sh\\necho bunker\\n' > dist/bunker;; esac`);
  exe(join(fakes, "docker"), `[ "$1" = --version ] && echo "Docker version 28.1.0, build x"; exit 0`);
  exe(join(fakes, "gh"), `[ "$1" = --version ] && echo "gh version 2.80.0 (2026-01-01)"; exit 0`);
  exe(join(fakes, "claude"), `echo "2.1.0 (Claude Code)"`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("install.sh", () => {
  test("--check prints a pass list and installs nothing", () => {
    const r = run(["--check"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bunker installer");
    expect(r.out).toContain("✓ bun");
    expect(r.out).toContain("✓ docker");
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("missing bun stops with the install hint", () => {
    rmSync(join(fakes, "bun"));
    const r = run(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ bun");
    expect(r.out).toContain("https://bun.sh/docs/installation");
    expect(r.out).toContain("install bun, then re-run");
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("missing runtime tool stops unless --skip-runtime-check", () => {
    rmSync(join(fakes, "claude"));
    expect(run(["--yes"]).code).toBe(1);
    const r = run(["--yes", "--skip-runtime-check"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".local", "bin", "bunker"))).toBe(true);
  });

  test("prints the plan and declines without a tty", () => {
    const r = run([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(".local/share/bunker");
    expect(r.out).toContain(".local/bin/bunker");
    expect(r.out).toContain("does not edit your shell rc files");
    expect(existsSync(join(home, ".local", "bin", "bunker"))).toBe(false);
  });

  test("--yes installs the latest tag and says what's next", () => {
    release("1.1.0");
    const r = run(["--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1.1.0 (v1.1.0)");
    expect(r.out).toContain("cd <repo> && bunker init");
    expect(r.out).toContain("export PATH=");
    expect(existsSync(join(home, ".local", "bin", "bunker"))).toBe(true);
  });

  test("re-running upgrades in place", () => {
    expect(run(["--yes"]).out).toContain("(v1.0.0)");
    release("1.2.0");
    const r = run(["--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1.2.0 (v1.2.0)");
  });

  test("refuses while a watch is running", () => {
    expect(run(["--yes"]).code).toBe(0);
    const lock = join(home, ".local", "share", "bunker", ".bunker");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "watch.lock"), String(process.pid));
    const r = run(["--yes"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--watch");
  });

  test("--uninstall removes the binary and checkout, not config", () => {
    run(["--yes"]);
    mkdirSync(join(home, ".config", "bunker"), { recursive: true });
    const r = run(["--uninstall", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(".local/bin/bunker");
    expect(existsSync(join(home, ".local", "bin", "bunker"))).toBe(false);
    expect(existsSync(join(home, ".local", "share", "bunker"))).toBe(false);
    expect(existsSync(join(home, ".config", "bunker"))).toBe(true);
  });
});
