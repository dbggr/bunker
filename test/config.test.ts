import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { ConfigError, effectiveSettings, loadRepoConfig, parseConfig } from "../src/core/config.ts";
import { resolveModels } from "../src/agents/models.ts";
import { copyPatterns } from "../src/worktree/copy.ts";
import { cleanup, fakeWorld } from "./fakes.ts";

setDefaultTimeout(60_000); // see test/setup.ts
afterEach(cleanup);

const FULL = `
setup = "bun install"
verify = "bun test"
copy = [".env", "config/*.json"]

[models]
implementer = "m-impl"
reviewer = "m-rev"
auditor = "m-aud"
default = "m-def"

[watch]
interval = 5
parallel = 3
max_cost_day = 10
max_cost_month = 100.5
audit_every = 30
triage_every = 12

[merge]
ci_timeout = 45

[notify]
enabled = false
github_user = "carol"
`;

describe("parseConfig", () => {
  test("merge = \"manual\" and [merge] mode = \"manual\" both set the merge mode; other values are refused", () => {
    expect(parseConfig('merge = "manual"').config.merge).toEqual({ mode: "manual" });
    expect(parseConfig('[merge]\nmode = "manual"\nci_timeout = 5').config.merge).toEqual({ mode: "manual", ci_timeout: 5 });
    expect(parseConfig('merge = "auto"').config.merge).toEqual({ mode: "auto" });
    expect(() => parseConfig('merge = "yolo"')).toThrow('merge must be "auto" or "manual"');
    expect(() => parseConfig('[merge]\nmode = "yolo"')).toThrow("merge.mode");
  });

  test("reads every key", () => {
    const { config, warnings } = parseConfig(FULL);
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      setup: "bun install",
      verify: "bun test",
      copy: [".env", "config/*.json"],
      models: { implementer: "m-impl", reviewer: "m-rev", auditor: "m-aud", default: "m-def" },
      watch: { interval: 5, parallel: 3, max_cost_day: 10, max_cost_month: 100.5, audit_every: 30, triage_every: 12 },
      merge: { ci_timeout: 45 },
      skills: {},
      clean: {},
      notify: { enabled: false, github_user: "carol" },
    });
  });

  test("empty file is an empty config", () => {
    expect(parseConfig("").config).toEqual({ models: {}, skills: {}, watch: {}, merge: {}, notify: {}, clean: {} });
  });

  test("unknown keys warn, naming the key", () => {
    const { warnings, config } = parseConfig('verify = "x"\nbogus = 1\n[watch]\nspeed = 2\n[nope]\na = 1\n');
    expect(warnings.join("\n")).toContain("bogus");
    expect(warnings.join("\n")).toContain("watch.speed");
    expect(warnings.join("\n")).toContain("nope");
    expect(config.verify).toBe("x");
  });

  test.each([
    ["setup = 3", "setup", "string"],
    ["copy = 'x'", "copy", "array of strings"],
    ["copy = [1]", "copy", "array of strings"],
    ["[models]\nreviewer = 1", "models.reviewer", "string"],
    ["[watch]\ninterval = 'x'", "watch.interval", "positive number"],
    ["[watch]\ninterval = 0", "watch.interval", "positive number"],
    ["[watch]\nparallel = 1.5", "watch.parallel", "positive integer"],
    ["[watch]\nmax_cost_day = -1", "watch.max_cost_day", "positive number"],
    ["[merge]\nci_timeout = 'a'", "merge.ci_timeout", "positive number"],
    ["watch = 1", "watch", "table"],
  ])("bad type %p throws naming key and type", (text, key, type) => {
    let err: unknown;
    try {
      parseConfig(text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(key);
    expect((err as Error).message).toContain(type);
  });

  test("queue.allow_labelers in a repo file is ignored with a warning pointing at the user-level file", () => {
    const { config, warnings } = parseConfig('[queue]\nallow_labelers = ["mallory"]\n');
    expect(JSON.stringify(config)).not.toContain("mallory");
    expect(warnings.join("\n")).toContain("queue.allow_labelers");
    expect(warnings.join("\n")).toContain("~/.config/bunker/config.toml");
  });

  test("invalid TOML is a ConfigError", () => {
    expect(() => parseConfig("= =")).toThrow(ConfigError);
  });
});

describe("loadRepoConfig", () => {
  test("no files: empty, no legacy, no notes", async () => {
    const w = await fakeWorld();
    await Bun.$`rm ${w.repo}/.bunker/verify`;
    const r = await loadRepoConfig(w.repo);
    expect(r.config.verify).toBeUndefined();
    expect(r.legacy).toEqual({});
    expect(r.notes).toEqual([]);
  });

  test("reads legacy files", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/setup"), "make deps\n");
    await Bun.write(join(w.repo, ".bunker/copy"), "# c\n.env\n\n");
    const r = await loadRepoConfig(w.repo);
    expect(r.legacy).toEqual({ setup: "sh .bunker/setup", verify: "bun test", copy: [".env"] });
  });

  test("both config.toml and legacy files: one deprecation note", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/config.toml"), 'verify = "make"\n');
    const r = await loadRepoConfig(w.repo);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("deprecated");
    expect(r.notes[0]).toContain(".bunker/verify");
  });
});

describe("precedence", () => {
  const cfg = parseConfig(FULL).config;

  test("config.toml beats legacy beats default", () => {
    const legacy = { verify: "legacy-verify", setup: "sh .bunker/setup", copy: ["l"] };
    const s = effectiveSettings({ config: cfg, legacy, env: {} });
    expect(s.find((x) => x.key === "verify")).toMatchObject({ value: "bun test", source: "config.toml" });
    const l = effectiveSettings({ config: parseConfig("").config, legacy, env: {} });
    expect(l.find((x) => x.key === "verify")).toMatchObject({ value: "legacy-verify", source: ".bunker/verify" });
    expect(l.find((x) => x.key === "copy")).toMatchObject({ value: ["l"], source: ".bunker/copy" });
    expect(l.find((x) => x.key === "watch.interval")).toMatchObject({ value: 10, source: "default" });
    expect(l.find((x) => x.key === "verify")).toBeDefined();
  });

  test("env beats config.toml for models", () => {
    const s = effectiveSettings({ config: cfg, legacy: {}, env: { BUNKER_REVIEWER_MODEL: "env-rev", BUNKER_MODEL: "env-def" } });
    expect(s.find((x) => x.key === "models.reviewer")).toMatchObject({ value: "env-rev", source: "env BUNKER_REVIEWER_MODEL" });
    expect(s.find((x) => x.key === "models.implementer")).toMatchObject({ value: "env-def", source: "env BUNKER_MODEL" });
  });

  test("resolveModels: flag > env > config role > config default", () => {
    const models = cfg.models;
    expect(resolveModels({ "reviewer-model": "flag" }, { BUNKER_REVIEWER_MODEL: "env" }, models).reviewer).toBe("flag");
    expect(resolveModels({}, { BUNKER_REVIEWER_MODEL: "env" }, models).reviewer).toBe("env");
    expect(resolveModels({}, { BUNKER_MODEL: "envdef" }, models).implementer).toBe("envdef");
    expect(resolveModels({}, {}, models).reviewer).toBe("m-rev");
    expect(resolveModels({}, {}, { default: "d" }).auditor).toBe("d");
    expect(resolveModels({}, {}, {})).toEqual({});
  });

  test("copyPatterns: config.toml, then legacy file", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/copy"), ".legacy\n");
    expect(await copyPatterns(w.repo)).toEqual([".legacy"]);
    await Bun.write(join(w.repo, ".bunker/config.toml"), 'copy = [".new"]\n');
    expect(await copyPatterns(w.repo)).toEqual([".new"]);
    expect(await copyPatterns(w.repo, ["x"])).toEqual(["x"]);
  });
});

describe("cli", () => {
  const run = async (repo: string, env: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { cwd: repo, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code: p.exitCode };
  };

  test("bad type exits 2 with the key and expected type", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/config.toml"), "[watch]\ninterval = 'soon'\n");
    const r = await run(w.repo, w.env, "issue", "1", "--no-pull");
    expect(r.code).toBe(2);
    expect(r.err).toContain("watch.interval");
    expect(r.err).toContain("positive number");
  });

  test("unknown key warns but proceeds", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/config.toml"), "bogus = 1\n");
    const r = await run(w.repo, w.env, "issue", "x", "--no-pull");
    expect(r.err).toContain("bogus");
    expect(r.err).toContain("issue number must be a positive integer");
  });

  test("doctor shows each setting's value and source", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/config.toml"), '[watch]\ninterval = 7\n');
    const r = await run(w.repo, w.env, "doctor");
    expect(r.out).toContain("watch.interval: 7 (config.toml)");
    expect(r.out).toContain("verify: bun test (.bunker/verify)");
    expect(r.out).toContain("merge.ci_timeout: 30 (default)");
  });
});

describe("config.toml notify table", () => {
  test("notify.enabled (boolean) and notify.github_user (string) are read", () => {
    const { config, warnings } = parseConfig('[notify]\nenabled = false\ngithub_user = "paul"\n');
    expect(warnings).toEqual([]);
    expect(config.notify).toEqual({ enabled: false, github_user: "paul" });
  });
  test("notify.enabled must be a boolean", () => {
    expect(() => parseConfig('[notify]\nenabled = "no"\n')).toThrow(ConfigError);
    expect(() => parseConfig('[notify]\nenabled = "no"\n')).toThrow(/notify.enabled must be true or false/);
  });
  test("an empty config has an empty notify table", () => {
    expect(parseConfig("").config.notify).toEqual({});
  });
});

test("clean.logs_days is parsed and validated", () => {
  expect(parseConfig("[clean]\nlogs_days = 7").config.clean.logs_days).toBe(7);
  expect(() => parseConfig('[clean]\nlogs_days = "x"')).toThrow();
});

test("verify_retries (0 allowed) and check are parsed and validated", () => {
  const c = parseConfig('verify_retries = 0\ncheck = "bun run typecheck"').config;
  expect(c.verify_retries).toBe(0);
  expect(c.check).toBe("bun run typecheck");
  expect(() => parseConfig("verify_retries = -1")).toThrow();
  expect(() => parseConfig("verify_retries = 1.5")).toThrow();
  expect(() => parseConfig("check = 3")).toThrow();
  const s = effectiveSettings({ config: parseConfig("").config, legacy: {}, env: {} });
  expect(s.find((x) => x.key === "verify_retries")?.value).toBe(1);
});
