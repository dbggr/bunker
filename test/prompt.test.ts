import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptTemplate, renderPrompt } from "../src/prompt.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "bunker-prompt-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("renderPrompt", () => {
  test("substitutes {{KEY}} from vars", async () => {
    const cwd = await tmp();
    expect(await renderPrompt("#{{ NUM }} on {{BRANCH}}", { cwd, vars: { NUM: "7", BRANCH: "b" } })).toBe("#7 on b");
  });

  test("unknown key is an error", async () => {
    const cwd = await tmp();
    await expect(renderPrompt("hi {{NOPE}}", { cwd, vars: {} })).rejects.toThrow(/unknown.*NOPE/i);
  });

  test("!`cmd` runs in cwd and is inlined", async () => {
    const cwd = await tmp();
    await Bun.write(join(cwd, "f.txt"), "hello\n");
    expect(await renderPrompt("got: !`cat f.txt`.", { cwd, vars: {} })).toBe("got: hello.");
  });

  test("untrusted values stay literal: no key or command expansion", async () => {
    const cwd = await tmp();
    const out = await renderPrompt("A {{BODY}} B", { cwd, vars: { BODY: "{{X}} !`echo pwned`" } });
    expect(out).toBe("A {{X}} !`echo pwned` B");
  });

  test("command output is not re-expanded", async () => {
    const cwd = await tmp();
    expect(await renderPrompt("!`printf '{{X}} %s' '!'`", { cwd, vars: {} })).toBe("{{X}} !");
  });

  test("commands do not see GitHub or Claude tokens", async () => {
    const cwd = await tmp();
    const env = { PATH: process.env.PATH, KEEP: "yes" };
    expect(await renderPrompt("!`echo $KEEP-$GH_TOKEN-$CLAUDE_CODE_OAUTH_TOKEN`", { cwd, vars: {}, env })).toBe("yes--");
  });

  test("default env drops tokens", async () => {
    const cwd = await tmp();
    process.env.GH_TOKEN = "secret";
    try {
      expect(await renderPrompt("!`echo [$GH_TOKEN]`", { cwd, vars: {} })).toBe("[]");
    } finally {
      delete process.env.GH_TOKEN;
    }
  });

  test("a command that times out or fails is an error", async () => {
    const cwd = await tmp();
    await expect(renderPrompt("!`sleep 5`", { cwd, vars: {}, timeoutMs: 100 })).rejects.toThrow(/timed out/);
    await expect(renderPrompt("!`exit 3`", { cwd, vars: {} })).rejects.toThrow(/exit 3/);
  });
});

describe("loadPromptTemplate", () => {
  // #316: templates come from a commit on the default branch, never a worktree's files.
  test("reads the template at the given commit, ignoring the working tree", async () => {
    const repo = await tmp();
    await $`git init -q -b main ${repo} && git -C ${repo} -c user.name=T -c user.email=t@e commit -q --allow-empty -m init`;
    const bare = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    expect(await loadPromptTemplate(repo, bare, "issue", "builtin")).toBe("builtin");
    await mkdir(join(repo, ".bunker", "prompts"), { recursive: true });
    await Bun.write(join(repo, ".bunker", "prompts", "issue.md"), "custom");
    await $`git -C ${repo} add -A && git -C ${repo} -c user.name=T -c user.email=t@e commit -qm t`;
    const withTemplate = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
    await Bun.write(join(repo, ".bunker", "prompts", "issue.md"), "edited in the worktree");
    expect(await loadPromptTemplate(repo, withTemplate, "issue", "builtin")).toBe("custom");
    expect(await loadPromptTemplate(repo, bare, "issue", "builtin")).toBe("builtin");
  });

  test("an unreadable commit is an error, not the built-in", async () => {
    const repo = await tmp();
    await $`git init -q -b main ${repo}`;
    await expect(loadPromptTemplate(repo, "0000000000000000000000000000000000000000", "issue", "builtin")).rejects.toThrow(/prompt/);
  });
});
