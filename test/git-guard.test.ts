import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, hardenHostGit, noSandbox } from "../src/index.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A repo with one linked worktree, like bunker makes for each run. */
async function repoWithWorktree() {
  const root = await mkdtemp(join(tmpdir(), "bunker-guard-"));
  dirs.push(root);
  const repo = join(root, "repo");
  const worktree = join(root, "wt");
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} commit -q --allow-empty -m init`;
  await $`git -C ${repo} worktree add -q -b bunker/t ${worktree}`;
  const gitCommonDir = join(repo, ".git");
  const admin = readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
  return { root, repo, worktree, gitCommonDir, admin };
}

const sh = (script: string) => ["sh", "-c", script];

describe("git integrity guard (every sandbox exec)", () => {
  test("a planted hook is detected, removed, and the step fails", async () => {
    const { worktree, gitCommonDir } = await repoWithWorktree();
    const hook = join(gitCommonDir, "hooks", "pre-push");
    await expect(
      noSandbox().exec(sh(`printf '#!/bin/sh\\ntouch /tmp/pwned\\n' > ${hook}; chmod +x ${hook}`), { worktree, gitCommonDir }),
    ).rejects.toThrow(/agent modified git config or hooks: .*hooks\/pre-push/);
    expect(existsSync(hook)).toBe(false);
  });

  test("a config change is detected and the original config restored", async () => {
    const { worktree, gitCommonDir } = await repoWithWorktree();
    const before = readFileSync(join(gitCommonDir, "config"), "utf8");
    await expect(
      noSandbox().exec(sh(`git config core.fsmonitor 'touch /tmp/pwned'`), { worktree, gitCommonDir }),
    ).rejects.toThrow(/agent modified git config or hooks: .*config/);
    expect(readFileSync(join(gitCommonDir, "config"), "utf8")).toBe(before);
  });

  test("rewriting the worktree's .git pointer or the admin commondir is detected and restored", async () => {
    const { worktree, gitCommonDir, admin } = await repoWithWorktree();
    const dotGit = readFileSync(join(worktree, ".git"), "utf8");
    const commondir = readFileSync(join(admin, "commondir"), "utf8");
    await expect(
      noSandbox().exec(sh(`echo 'gitdir: /tmp/evil' > .git; echo /tmp/evil > ${join(admin, "commondir")}`), { worktree, gitCommonDir }),
    ).rejects.toThrow(/agent modified git config or hooks/);
    expect(readFileSync(join(worktree, ".git"), "utf8")).toBe(dotGit);
    expect(readFileSync(join(admin, "commondir"), "utf8")).toBe(commondir);
  });

  test("ordinary commits by the agent are fine", async () => {
    const { worktree, gitCommonDir } = await repoWithWorktree();
    const r = await noSandbox().exec(sh("echo hi > f.txt && git add f.txt && git commit -qm feat"), { worktree, gitCommonDir });
    expect(r.code).toBe(0);
    expect((await $`git -C ${worktree} log --oneline`.text()).trim().split("\n")).toHaveLength(2);
  });
});

describe("hardenHostGit()", () => {
  test("host git ignores hooks and fsmonitor set in the repo", async () => {
    const { repo } = await repoWithWorktree();
    const marker = join(repo, "..", "hook-ran");
    await Bun.write(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(join(repo, ".git", "hooks", "pre-commit"), 0o755);
    await $`git -C ${repo} config core.fsmonitor ${`touch ${marker}`}`;
    hardenHostGit();
    hardenHostGit(); // idempotent
    await $`git -C ${repo} commit -q --allow-empty -m second`;
    await $`git -C ${repo} status --short`.quiet();
    expect(existsSync(marker)).toBe(false);
    expect((await $`git -C ${repo} config core.hooksPath`.text()).trim()).toBe("/dev/null");
  });
});

describe("container sandbox mounts and verify isolation", () => {
  async function fakeDocker(root: string) {
    const bin = join(root, "fake-docker");
    await Bun.write(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/docker-args.txt"\n`);
    await chmod(bin, 0o755);
    return bin;
  }
  const args = (root: string) => readFileSync(join(root, "docker-args.txt"), "utf8").split("\n");

  test("the git common dir is read-only; only objects/refs/logs and this worktree's admin dir are writable; pointer files read-only", async () => {
    const { root, worktree, gitCommonDir, admin } = await repoWithWorktree();
    const sb = docker({ image: "img", bin: await fakeDocker(root) });
    await sb.exec(["true"], { worktree, gitCommonDir });
    const a = args(root);
    expect(a).toContain(`${gitCommonDir}:${gitCommonDir}:ro`);
    for (const sub of ["objects", "refs", "logs"]) expect(a).toContain(`${join(gitCommonDir, sub)}:${join(gitCommonDir, sub)}`);
    expect(a).toContain(`${admin}:${admin}`);
    for (const f of [join(admin, "commondir"), join(admin, "gitdir"), join(worktree, ".git")]) expect(a).toContain(`${f}:${f}:ro`);
    expect(a).not.toContain(`${gitCommonDir}:${gitCommonDir}`);
    expect(a).not.toContain("--network");
  });

  test("an isolated exec (verify) has no network and no Claude credentials", async () => {
    const { root, worktree, gitCommonDir } = await repoWithWorktree();
    const sb = docker({ image: "img", bin: await fakeDocker(root) });
    await sb.exec(["true"], { worktree, gitCommonDir, isolate: true });
    const a = args(root);
    expect(a.join(" ")).toContain("--network none");
    expect(a).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(a).not.toContain("ANTHROPIC_API_KEY");
  });

  test("noSandbox isolated exec strips Claude credentials and GitHub tokens from the env", async () => {
    const { worktree, gitCommonDir } = await repoWithWorktree();
    const saved = { ...process.env };
    Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: "c", ANTHROPIC_API_KEY: "a", GH_TOKEN: "g", BUNKER_GH_TOKEN: "b" });
    try {
      const r = await noSandbox().exec(sh('echo "[$CLAUDE_CODE_OAUTH_TOKEN|$ANTHROPIC_API_KEY|$GH_TOKEN|$BUNKER_GH_TOKEN]"'), { worktree, gitCommonDir, isolate: true });
      expect(r.stdout.trim()).toBe("[|||]");
    } finally {
      for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GH_TOKEN", "BUNKER_GH_TOKEN"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
