import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBunkerEnv } from "../src/env.ts";
import { claudeCode, review, noSandbox } from "../src/index.ts";
import { modelLabel, resolveModels } from "../src/models.ts";
import { createProgress, type BunkerEvent } from "../src/events.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("resolveModels", () => {
  const env = {
    BUNKER_MODEL: "env-default",
    BUNKER_IMPLEMENTER_MODEL: "env-impl",
    BUNKER_REVIEWER_MODEL: "env-rev",
    BUNKER_AUDITOR_MODEL: "env-aud",
  };
  const flags = { model: "flag-all", "implementer-model": "flag-impl", "reviewer-model": "flag-rev", "auditor-model": "flag-aud" };

  test("role flag > --model > role env > BUNKER_MODEL > unset", () => {
    expect(resolveModels(flags, env)).toEqual({ implementer: "flag-impl", reviewer: "flag-rev", auditor: "flag-aud" });
    const { "implementer-model": _i, "reviewer-model": _r, "auditor-model": _a, ...onlyAll } = flags;
    expect(resolveModels(onlyAll, env)).toEqual({ implementer: "flag-all", reviewer: "flag-all", auditor: "flag-all" });
    expect(resolveModels({}, env)).toEqual({ implementer: "env-impl", reviewer: "env-rev", auditor: "env-aud" });
    expect(resolveModels({}, { BUNKER_MODEL: "env-default" })).toEqual({ implementer: "env-default", reviewer: "env-default", auditor: "env-default" });
    expect(resolveModels({}, {})).toEqual({});
  });

  test("roles resolve independently", () => {
    expect(resolveModels({ "reviewer-model": "opus" }, { BUNKER_IMPLEMENTER_MODEL: "sonnet" })).toEqual({ implementer: "sonnet", reviewer: "opus" });
    expect(resolveModels({ model: "m", "reviewer-model": "r" }, {})).toEqual({ implementer: "m", reviewer: "r", auditor: "m" });
  });

  test("empty values count as unset", () => {
    expect(resolveModels({ model: "" }, { BUNKER_MODEL: "" , BUNKER_REVIEWER_MODEL: "r" })).toEqual({ reviewer: "r" });
  });

  test("repo .bunker/.env overrides the user file; exported beats both", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunker-models-"));
    dirs.push(root);
    await $`mkdir -p ${root}/repo/.bunker ${root}/home/bunker`;
    await Bun.write(`${root}/repo/.bunker/.env`, "BUNKER_REVIEWER_MODEL=repo-rev\n");
    await Bun.write(`${root}/home/bunker/.env`, "BUNKER_REVIEWER_MODEL=user-rev\nBUNKER_MODEL=user-all\n");
    const e: Record<string, string | undefined> = { XDG_CONFIG_HOME: `${root}/home` };
    await loadBunkerEnv(`${root}/repo`, e);
    expect(resolveModels({}, e)).toEqual({ implementer: "user-all", reviewer: "repo-rev", auditor: "user-all" });
    const exported: Record<string, string | undefined> = { XDG_CONFIG_HOME: `${root}/home`, BUNKER_REVIEWER_MODEL: "exp" };
    await loadBunkerEnv(`${root}/repo`, exported);
    expect(resolveModels({}, exported).reviewer).toBe("exp");
  });
});

describe("claudeCode / modelLabel", () => {
  test("unset → no --model passed", () => {
    expect(claudeCode({}).command("x")).not.toContain("--model");
    expect(claudeCode({ model: undefined }).model).toBeUndefined();
  });
  test("labels", () => {
    expect(modelLabel(claudeCode({ model: "claude-sonnet-5-5" }))).toBe("claude-sonnet-5-5");
    expect(modelLabel(claudeCode({}))).toBe("Claude default");
  });
});

describe("visibility", () => {
  test("stage events carry the model of the role; progress prints it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunker-models-rev-"));
    dirs.push(root);
    await $`git init -q -b main ${root} && git -C ${root} config user.name T && git -C ${root} config user.email t@t && git -C ${root} commit -q --allow-empty -m init`;
    const write = ["sh", "-c", "echo hi > a.txt && git add . && git commit -qm 'feat: x'"];
    const impl = { model: "impl-m", command: () => write };
    const rev = { model: "rev-m", command: () => ["echo", "<review>APPROVE</review>"] };
    const events: BunkerEvent[] = [];
    await review({ cwd: root, prompt: "x", agent: impl, reviewer: rev, sandbox: noSandbox(), onEvent: (e) => events.push(e) });
    const stages = events.filter((e) => e.type === "stage" && e.role).map((e) => `${e.name}:${e.model}`);
    expect(stages).toEqual(["implement:impl-m", "review:rev-m"]);

    let out = "";
    const p = createProgress({ write: (s: string) => void (out += s), tty: false } as never);
    for (const e of events) p.onEvent(e);
    expect(out).toContain("implement · impl-m");
    expect(out).toContain("review · rev-m");
  });
});

describe("auditor stage event", () => {
  test("progress shows the auditor role and its model", () => {
    let out = "";
    const p = createProgress({ write: (s: string) => void (out += s), tty: false } as never);
    p.onEvent({ type: "stage", name: "audit", role: "auditor", model: "aud-m", at: 0 });
    expect(out).toContain("auditor · audit · aud-m");
  });
});
