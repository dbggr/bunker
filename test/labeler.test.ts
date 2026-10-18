import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLabeler, configAllowedLabelers, enforceLabeler } from "../src/github/labeler.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Fake gh: label events name `adder`; `roles` maps login -> role_name (missing = lookup error). */
async function fakeGh(adder: string | null, roles: Record<string, string>, eventsFail = false, edits: { at: string; login: string }[] = [], graphqlFail = false) {
  const root = await mkdtemp(join(tmpdir(), "bunker-labeler-"));
  dirs.push(root);
  const roleCases = Object.entries(roles).map(([u, r]) => `  *"collaborators/${u}/permission"*) echo ${r};;`).join("\n");
  await Bun.write(
    join(root, "gh"),
    `#!/bin/sh
echo "$*" >> "${root}/log"
case "$*" in
  *graphql*) ${graphqlFail ? 'echo "HTTP 502" >&2; exit 1' : [...edits.map((e) => `printf "edit\\t%s\\t%s\\n" ${e.at} "${e.login}"`), "exit 0"].join("; ")};;
  *renamed*) exit 0;;
  *created_at*) ${eventsFail ? 'echo "HTTP 403" >&2; exit 1' : adder ? "echo 2026-01-01T00:00:00Z" : "true"};;
  *"/events"*) ${eventsFail ? 'echo "HTTP 403" >&2; exit 1' : adder ? `echo previous; echo ${adder}` : "true"};;
${roleCases}
  *"collaborators/"*) echo "HTTP 403: Resource not accessible" >&2; exit 1;;
  "issue edit"*|"issue comment"*) exit 0;;
  *) exit 1;;
esac
`,
  );
  await chmod(join(root, "gh"), 0o755);
  return { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } as Record<string, string>, log: () => Bun.file(join(root, "log")).text().catch(() => "") };
}

describe("enforceLabeler()", () => {
  test("a label added by an admin runs", async () => {
    const g = await fakeGh("owner", { owner: "admin" });
    expect(await enforceLabeler(7, { cwd: process.cwd(), env: g.env, log: () => {} })).toBe(true);
    expect(await g.log()).not.toContain("issue edit");
  });

  test("a maintainer runs", async () => {
    const g = await fakeGh("mia", { mia: "maintain" });
    expect(await enforceLabeler(7, { cwd: process.cwd(), env: g.env, log: () => {} })).toBe(true);
  });

  for (const role of ["triage", "write"]) {
    test(`a ${role} user is skipped, the label removed and a comment posted`, async () => {
      const g = await fakeGh("tess", { tess: role });
      expect(await enforceLabeler(7, { cwd: process.cwd(), env: g.env, log: () => {} })).toBe(false);
      const log = await g.log();
      expect(log).toContain("issue edit 7 --remove-label bunker");
      expect(log).toContain("issue comment 7 --body @tess only maintainers can queue bunker work");
    });
  }

  test("a permission lookup error fails closed and says why, without touching the issue", async () => {
    const g = await fakeGh("tess", {});
    const logs: string[] = [];
    expect(await enforceLabeler(7, { cwd: process.cwd(), env: g.env, log: (t) => logs.push(t) })).toBe(false);
    expect(logs.join("\n")).toContain("could not look up @tess's permission");
    expect(await g.log()).not.toContain("issue edit");
  });

  test("an issue never labeled bunker fails closed and says to add the label", async () => {
    const g = await fakeGh(null, {});
    const logs: string[] = [];
    expect(await enforceLabeler(7, { cwd: process.cwd(), env: g.env, log: (t) => logs.push(t) })).toBe(false);
    expect(logs.join("\n")).toContain("no `bunker:queued` label event found on #7 (add the label first");
    expect(await g.log()).not.toContain("issue edit");
  });

  describe("edits after labelling", () => {
    const run = (g: Awaited<ReturnType<typeof fakeGh>>) => enforceLabeler(7, { cwd: process.cwd(), env: g.env, log: () => {} });

    test("an outsider's edit after the label is refused: label removed, adder told", async () => {
      const g = await fakeGh("owner", { owner: "admin", eve: "read" }, false, [{ at: "2026-01-02T00:00:00Z", login: "eve" }]);
      expect(await run(g)).toBe(false);
      const log = await g.log();
      expect(log).toContain("issue edit 7 --remove-label bunker");
      expect(log).toContain("issue comment 7 --body @owner issue was edited after it was queued; re-check and relabel");
    });

    test("an edit before the label runs", async () => {
      const g = await fakeGh("owner", { owner: "admin", eve: "read" }, false, [{ at: "2025-12-31T00:00:00Z", login: "eve" }]);
      expect(await run(g)).toBe(true);
    });

    test("a maintainer's edit after the label runs", async () => {
      const g = await fakeGh("owner", { owner: "admin", mia: "maintain" }, false, [{ at: "2026-01-02T00:00:00Z", login: "mia" }]);
      expect(await run(g)).toBe(true);
    });

    test("an edit by a deleted user is refused", async () => {
      const g = await fakeGh("owner", { owner: "admin" }, false, [{ at: "2026-01-02T00:00:00Z", login: "" }]);
      expect(await run(g)).toBe(false);
    });

    test("an API error fails closed without touching the issue", async () => {
      const g = await fakeGh("owner", { owner: "admin" }, false, [], true);
      const logs: string[] = [];
      expect(await enforceLabeler(7, { cwd: process.cwd(), env: g.env, log: (t) => logs.push(t) })).toBe(false);
      expect(logs.join("\n")).toContain("could not check #7 for edits");
      expect(await g.log()).not.toContain("issue edit");
    });

    test("an editor whose permission can't be read fails closed", async () => {
      const g = await fakeGh("owner", { owner: "admin" }, false, [{ at: "2026-01-02T00:00:00Z", login: "eve" }]);
      expect(await run(g)).toBe(false);
      expect(await g.log()).not.toContain("issue edit");
    });
  });

  test("an events lookup error fails closed", async () => {
    const g = await fakeGh(null, {}, true);
    const r = await checkLabeler(7, { cwd: process.cwd(), env: g.env });
    expect(r.ok).toBe(false);
  });

  test("no label event fails closed", async () => {
    const g = await fakeGh(null, {});
    expect((await checkLabeler(7, { cwd: process.cwd(), env: g.env })).ok).toBe(false);
  });

  test("--allow-labeler lets a lower role run, case-insensitively, without a lookup", async () => {
    const g = await fakeGh("Tess", { Tess: "write" });
    expect(await enforceLabeler(7, { cwd: process.cwd(), env: g.env, allow: ["tess"], log: () => {} })).toBe(true);
    expect(await g.log()).not.toContain("collaborators");
  });
});

describe("configAllowedLabelers()", () => {
  test("reads allow-labelers from config.toml", async () => {
    const home = await mkdtemp(join(tmpdir(), "bunker-cfg-"));
    dirs.push(home);
    await Bun.write(join(home, "bunker", "config.toml"), 'allow-labelers = ["a", "b"]\n');
    expect(await configAllowedLabelers({ XDG_CONFIG_HOME: home })).toEqual(["a", "b"]);
    expect(await configAllowedLabelers({ XDG_CONFIG_HOME: join(home, "none") })).toEqual([]);
  });
});
