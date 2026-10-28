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
  test("review_paths is an array of strings", () => {
    expect(parseConfig('review_paths = ["src/gate/**"]').config.review_paths).toEqual(["src/gate/**"]);
    expect(() => parseConfig("review_paths = 1")).toThrow(ConfigError);
  });

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
      services: {},
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
    expect(parseConfig("").config).toEqual({ services: {}, models: {}, skills: {}, watch: {}, merge: {}, notify: {}, clean: {} });
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
  test("no files: empty config", async () => {
    const w = await fakeWorld();
    await Bun.$`rm ${w.repo}/.bunker/config.toml`;
    const r = await loadRepoConfig(w.repo);
    expect(r.config.verify).toBeUndefined();
    expect(r.legacy).toEqual({});
    expect(r.removedFiles).toEqual([]);
  });

  test("reads the legacy copy file", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/copy"), "# c\n.env\n\n");
    expect((await loadRepoConfig(w.repo)).legacy).toEqual({ copy: [".env"] });
  });

  test.each(["verify", "setup"])(".bunker/%s is an error naming the config.toml fix, and is never read", async (name) => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker", name), "make\n");
    const err = await loadRepoConfig(w.repo).then(() => "", (e: Error) => e.message);
    expect(err).toContain(`.bunker/${name} is no longer read`);
    expect(err).toContain(`${name} = "…"`);
    const r = await loadRepoConfig(w.repo, { lenient: true });
    expect(r.removedFiles).toEqual([name]);
    expect(r.legacy).toEqual({});
  });
});

describe("precedence", () => {
  const cfg = parseConfig(FULL).config;

  test("config.toml beats legacy beats default", () => {
    const legacy = { copy: ["l"] };
    const s = effectiveSettings({ config: cfg, legacy, env: {} });
    expect(s.find((x) => x.key === "verify")).toMatchObject({ value: "bun test", source: "config.toml" });
    const l = effectiveSettings({ config: parseConfig("").config, legacy, env: {} });
    expect(l.find((x) => x.key === "copy")).toMatchObject({ value: ["l"], source: ".bunker/copy" });
    expect(l.find((x) => x.key === "watch.interval")).toMatchObject({ value: 10, source: "default" });
    expect(l.find((x) => x.key === "verify")).toBeDefined();
  });

  test("config.toml beats env for models; env fills roles the repo leaves unset", () => {
    const env = { BUNKER_REVIEWER_MODEL: "env-rev", BUNKER_MODEL: "env-def" };
    const s = effectiveSettings({ config: cfg, legacy: {}, env });
    expect(s.find((x) => x.key === "models.reviewer")).toMatchObject({ value: "m-rev", source: "config.toml" });
    expect(s.find((x) => x.key === "models.implementer")).toMatchObject({ value: "m-impl", source: "config.toml" });
    const onlyDefault = effectiveSettings({ config: parseConfig('[models]\ndefault = "d"').config, legacy: {}, env });
    expect(onlyDefault.find((x) => x.key === "models.reviewer")).toMatchObject({ value: "d", source: "config.toml (models.default)" });
    const none = effectiveSettings({ config: parseConfig("").config, legacy: {}, env });
    expect(none.find((x) => x.key === "models.reviewer")).toMatchObject({ value: "env-rev", source: "env BUNKER_REVIEWER_MODEL" });
    expect(none.find((x) => x.key === "models.implementer")).toMatchObject({ value: "env-def", source: "env BUNKER_MODEL" });
  });

  test("resolveModels: flag > config role > config default > role env > BUNKER_MODEL", () => {
    const models = cfg.models;
    expect(resolveModels({ "reviewer-model": "flag" }, { BUNKER_REVIEWER_MODEL: "env" }, models).reviewer).toBe("flag");
    expect(resolveModels({ model: "all" }, {}, models).reviewer).toBe("all");
    expect(resolveModels({}, { BUNKER_REVIEWER_MODEL: "env", BUNKER_MODEL: "envdef" }, models).reviewer).toBe("m-rev");
    expect(resolveModels({}, { BUNKER_REVIEWER_MODEL: "env" }, { default: "d" }).reviewer).toBe("d");
    expect(resolveModels({}, { BUNKER_REVIEWER_MODEL: "env", BUNKER_MODEL: "envdef" }, {})).toEqual({ implementer: "envdef", reviewer: "env", auditor: "envdef" });
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
    await Bun.write(join(w.repo, ".bunker/config.toml"), 'verify = "bun test"\n[watch]\ninterval = 7\n');
    const r = await run(w.repo, w.env, "doctor");
    expect(r.out).toContain("watch.interval: 7 (config.toml)");
    expect(r.out).toContain("verify: bun test (config.toml)");
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

describe("services and prepare", () => {
  test("[services.<name>] tables and prepare are read", () => {
    const { config, warnings } = parseConfig(`prepare = "bin/migrate"\n[services.database]\nimage = "postgres:18-alpine"\nhealthcheck = "pg_isready"\n[services.database.env]\nPOSTGRES_PASSWORD = "x"\n[services.cache]\nimage = "redis:7"`);
    expect(warnings).toEqual([]);
    expect(config.prepare).toBe("bin/migrate");
    expect(config.services).toEqual({
      database: { image: "postgres:18-alpine", healthcheck: "pg_isready", env: { POSTGRES_PASSWORD: "x" } },
      cache: { image: "redis:7" },
    });
  });

  test("bad services are refused", () => {
    expect(() => parseConfig("[services.db]\nhealthcheck = 'x'")).toThrow("services.db.image");
    expect(() => parseConfig("[services.db]\nimage = 'x'\nenv = { A = 1 }")).toThrow("services.db.env");
    expect(() => parseConfig("[services.'a b']\nimage = 'x'")).toThrow("host name");
    expect(() => parseConfig("services = 'x'")).toThrow("services must be a table");
  });
});
