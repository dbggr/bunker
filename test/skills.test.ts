import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, noSandbox } from "../src/index.ts";
import { SkillError, resolveSkills, skillsForRoles } from "../src/core/skills.ts";
import { parseConfig } from "../src/core/config.ts";
import { formatChecks, runDoctor } from "../src/cli/commands/doctor.ts";
import { cleanup, fakeWorld } from "./fakes.ts";

setDefaultTimeout(60_000); // see test/setup.ts
afterEach(cleanup);

async function skillDir(name: string): Promise<{ home: string; dir: string }> {
  const home = await mkdtemp(join(tmpdir(), "bunker-skills-"));
  const dir = join(home, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `# ${name}\n`);
  return { home, dir };
}

test("config: skills as an array is the default list; a table sets roles", () => {
  expect(parseConfig('skills = ["~/a"]').config.skills).toEqual({ default: ["~/a"] });
  expect(parseConfig('[skills]\ndefault = ["a"]\nimplementer = ["b"]\nreviewer = ["c"]').config.skills).toEqual({ default: ["a"], implementer: ["b"], reviewer: ["c"] });
  expect(() => parseConfig("skills = 3")).toThrow(/skills/);
});

test("skillsForRoles: default goes to both roles, user list before repo list", () => {
  const r = skillsForRoles({ default: ["u1"], implementer: ["u2"] }, { default: ["r1"], reviewer: ["r2"] });
  expect(r.implementer).toEqual(["u1", "u2", "r1"]);
  expect(r.reviewer).toEqual(["u1", "r1", "r2"]);
});

test("resolveSkills expands ~ and names each skill after its directory", async () => {
  const { home, dir } = await skillDir("tdd");
  const [s] = resolveSkills(["~/.claude/skills/tdd"], home);
  expect(s).toEqual({ name: "tdd", path: dir });
});

test("a missing skill errors, naming the path", async () => {
  const { home } = await skillDir("tdd");
  expect(() => resolveSkills(["~/.claude/skills/nope"], home)).toThrow(SkillError);
  expect(() => resolveSkills(["~/.claude/skills/nope"], home)).toThrow(/\.claude\/skills\/nope/);
});

test("a symlink pointing outside the skill dir is refused", async () => {
  const { home, dir } = await skillDir("evil");
  await writeFile(join(home, "secret"), "s");
  await symlink(join(home, "secret"), join(dir, "link.md"));
  expect(() => resolveSkills([dir], home)).toThrow(/outside/);
  const b = await skillDir("evil2");
  await symlink("../../..", join(b.dir, "up"));
  expect(() => resolveSkills([b.dir], b.home)).toThrow(/outside/);
});

test("a symlink that stays inside the skill dir is fine", async () => {
  const { home, dir } = await skillDir("ok");
  await symlink("SKILL.md", join(dir, "alias.md"));
  expect(resolveSkills([dir], home)).toHaveLength(1);
});

test("two skills with the same name are an error", async () => {
  const a = await skillDir("tdd");
  const b = await skillDir("tdd");
  expect(() => resolveSkills([a.dir, b.dir], a.home)).toThrow(/tdd/);
});

async function fakeDocker() {
  const dir = await mkdtemp(join(tmpdir(), "bunker-skills-docker-"));
  await $`git init -q ${dir}`;
  await writeFile(join(dir, "docker"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\n`);
  await chmod(join(dir, "docker"), 0o755);
  return dir;
}

test("docker mounts each role's skills read-only under ~/.claude/skills, and nothing for other runs", async () => {
  const impl = await skillDir("tdd");
  const rev = await skillDir("review-checklist");
  const dir = await fakeDocker();
  const sandbox = docker({ image: "img", bin: join(dir, "docker"), skills: { implementer: [{ name: "tdd", path: impl.dir }], reviewer: [{ name: "review-checklist", path: rev.dir }] } });
  const ctx = { worktree: dir, gitCommonDir: join(dir, ".git") };
  const args = async () => (await readFile(join(dir, "args"), "utf8")).split("\n");

  await sandbox.exec(["agent"], { ...ctx, role: "implementer" });
  let a = await args();
  expect(a).toContain(`${impl.dir}:/tmp/.claude/skills/tdd:ro`);
  expect(a.join("\n")).not.toContain("review-checklist");

  await sandbox.exec(["agent"], { ...ctx, role: "reviewer" });
  a = await args();
  expect(a).toContain(`${rev.dir}:/tmp/.claude/skills/review-checklist:ro`);
  expect(a.join("\n")).not.toContain("/skills/tdd");

  await sandbox.exec(["agent"], ctx);
  expect((await args()).join("\n")).not.toContain("/.claude/skills/");
});

test("--no-sandbox links the role's skills into the temp HOME", async () => {
  const s = await skillDir("tdd");
  const dir = await mkdtemp(join(tmpdir(), "bunker-skills-ns-"));
  await $`git init -q ${dir}`;
  const sandbox = noSandbox({ skills: { implementer: [{ name: "tdd", path: s.dir }] } });
  const r = await sandbox.exec(["sh", "-c", "readlink -f $HOME/.claude/skills/tdd; ls $HOME/.claude/skills"], { worktree: dir, gitCommonDir: join(dir, ".git"), role: "implementer" });
  expect(r.stdout.trim().split("\n")).toEqual([s.dir, "tdd"]);
  const none = await sandbox.exec(["sh", "-c", "test -e $HOME/.claude/skills && echo yes || echo no"], { worktree: dir, gitCommonDir: join(dir, ".git"), role: "reviewer" });
  expect(none.stdout.trim()).toBe("no");
});

test("doctor lists the skills each role gets, and fails on a missing one", async () => {
  const w = await fakeWorld();
  const skill = join(w.env.HOME!, ".claude", "skills", "tdd");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "x");
  await mkdir(join(w.env.HOME!, ".config", "bunker"), { recursive: true });
  await writeFile(join(w.env.HOME!, ".config", "bunker", "config.toml"), '[skills]\nimplementer = ["~/.claude/skills/tdd"]\n');
  let r = await runDoctor({ cwd: w.repo, env: w.env });
  const text = formatChecks(r.checks);
  expect(text).toContain("skills (implementer): tdd");
  expect(text).toContain("skills (reviewer): none");
  expect(r.code).toBe(0);

  await writeFile(join(w.env.HOME!, ".config", "bunker", "config.toml"), 'skills = ["~/.claude/skills/gone"]\n');
  r = await runDoctor({ cwd: w.repo, env: w.env });
  expect(r.code).toBe(1);
  expect(formatChecks(r.checks)).toContain("gone");
});
