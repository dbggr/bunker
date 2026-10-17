import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { ConfigError, effectiveSettings, loadRepoConfig, parseConfig } from "../src/config.ts";
import { resolveModels } from "../src/models.ts";
import { copyPatterns } from "../src/copy.ts";
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

[merge]
ci_timeout = 45

[queue]
allow_labelers = ["alice", "bob"]
`;

describe("parseConfig", () => {
  test("reads every key", () => {
    const { config, warnings } = parseConfig(FULL);
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      setup: "bun install",
      verify: "bun test",
      copy: [".env", "config/*.json"],
      models: { implementer: "m-impl", reviewer: "m-rev", auditor: "m-aud", default: "m-def" },
      watch: { interval: 5, parallel: 3, max_cost_day: 10, max_cost_month: 100.5, audit_every: 30 },
      merge: { ci_timeout: 45 },
      queue: { allow_labelers: ["alice", "bob"] },
    });
  });

  test("empty file is an empty config", () => {
    expect(parseConfig("").config).toEqual({ models: {}, watch: {}, merge: {}, queue: {} });
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
    ["[queue]\nallow_labelers = 'a'", "queue.allow_labelers", "array of strings"],
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
    const r = await run(w.repo, w.env, "--issue", "1", "--no-pull");
    expect(r.code).toBe(2);
    expect(r.err).toContain("watch.interval");
    expect(r.err).toContain("positive number");
  });

  test("unknown key warns but proceeds", async () => {
    const w = await fakeWorld();
    await Bun.write(join(w.repo, ".bunker/config.toml"), "bogus = 1\n");
    const r = await run(w.repo, w.env, "--issue", "x", "--no-pull");
    expect(r.err).toContain("bogus");
    expect(r.err).toContain("--issue must be a positive integer");
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
