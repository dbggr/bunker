import { afterEach, describe, expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

const VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "BUNKER_GH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const orig = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of VARS) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
});

describe("redact()", () => {
  test("replaces values of secret env vars", () => {
    for (const k of VARS) process.env[k] = `opaque-${k}-value`;
    const out = redact(VARS.map((k) => `x ${process.env[k]} y`).join("\n"));
    expect(out).not.toContain("opaque-");
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(VARS.length);
  });

  test("ignores unset and empty vars", () => {
    for (const k of VARS) process.env[k] = "";
    expect(redact("plain text")).toBe("plain text");
  });

  test("replaces every occurrence", () => {
    process.env.GH_TOKEN = "s3cret!value";
    expect(redact("a s3cret!value b s3cret!value")).toBe("a [REDACTED] b [REDACTED]");
  });

  test("replaces token-shaped strings", () => {
    for (const k of VARS) delete process.env[k];
    const toks = ["github_pat_11ABCDEF0_abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "gho_abcdefghijklmnopqrstuvwxyz0123", "sk-ant-api03-abc_DEF-123456789"];
    for (const t of toks) expect(redact(`token=${t}.`)).toBe("token=[REDACTED].");
  });

  test("leaves ordinary text alone", () => {
    expect(redact("ghost sk-learn github")).toBe("ghost sk-learn github");
  });
});
