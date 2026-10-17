import { $ } from "bun";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
export const cleanup = async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
};

/** Fake gh, docker and claude on a PATH dir. gh answers from JSON files in `data/` (missing file = HTTP 404) and logs argv to `log`. */
export async function fakeWorld(opts: { files?: Record<string, string>; noTools?: string[]; ghAuthFails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bunker-fake-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const data = join(root, "data");
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(bin);
  await mkdir(data);
  await mkdir(home);
  await mkdir(repo);
  const log = join(root, "log");
  await Bun.write(log, "");
  const tool = async (name: string, body: string) => {
    if (opts.noTools?.includes(name)) body = "exit 127"; // present but unusable, whatever the host has
    await Bun.write(join(bin, name), `#!/bin/bash\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await tool(
    "gh",
    `echo "gh $*" >> "${log}"
echo "TOKEN=\${GH_TOKEN:-}" >> "${log}.env"
d="${data}"
f() { if [ -f "$d/$1" ]; then cat "$d/$1"; else echo "HTTP 404: Not Found" >&2; exit 1; fi; }
case "$*" in
  "auth status") exit ${opts.ghAuthFails ? 1 : 0};;
  "api repos/o/r") f repo.json;;
  "api repos/o/r/issues?per_page=1") f issues.json;;
  "api repos/o/r/pulls?per_page=1") f pulls.json;;
  "api repos/o/r/branches/main") f branch.json;;
  "label list"*) f labels.json;;
  "label create"*) exit 0;;
  "api repos/o/r/branches/main/protection/required_status_checks") f protection.json;;
  "api repos/o/r/rules/branches/main") f rules.json;;
  *) echo "fake gh: unhandled $*" >&2; exit 1;;
esac`,
  );
  await tool("docker", `echo "docker $*" >> "${log}"; exit 0`);
  await tool("claude", `echo "claude $*" >> "${log}"; echo "sk-ant-oat01-fromclaude"; exit 0`);
  const good: Record<string, string> = {
    "repo.json": JSON.stringify({ default_branch: "main", allow_auto_merge: true }),
    "issues.json": "[]",
    "pulls.json": "[]",
    "branch.json": "{}",
    "labels.json": JSON.stringify(["bunker", "discovered", "bunker-failed", "bunker-blocked"].map((name) => ({ name }))),
    "protection.json": JSON.stringify({ contexts: ["test"], checks: [{ context: "test" }] }),
    ...opts.files,
  };
  for (const [name, content] of Object.entries(good)) if (content !== "") await Bun.write(join(data, name), content);

  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} remote add origin https://github.com/o/r.git`;
  await Bun.write(join(repo, ".github/workflows/ci.yml"), "on: push\n");
  await Bun.write(join(repo, ".bunker/verify"), "bun test\n");

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
    BUNKER_GH_TOKEN: "github_pat_testtoken123",
  } as Record<string, string>;
  return {
    root,
    repo,
    home,
    env,
    data,
    log: () => readFile(log, "utf8"),
    ghEnvLog: () => readFile(`${log}.env`, "utf8").catch(() => ""),
  };
}
