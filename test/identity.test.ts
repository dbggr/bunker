import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIdentity, identityKind, liveGhEnv, mintAppToken } from "../src/github/identity.ts";
import { agentEnv } from "../src/sandboxes/env.ts";
import { markTrust } from "../src/github/trust.ts";
import { redact } from "../src/core/redact.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function keyFile() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = await mkdtemp(join(tmpdir(), "bunker-id-"));
  dirs.push(dir);
  const path = join(dir, "app.pem");
  await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  await chmod(path, 0o600);
  return { path, publicKey };
}

/** Fake GitHub App endpoints; records each call. */
function fakeGithub(expiresIn = 3600) {
  const calls: { url: string; method: string; auth: string }[] = [];
  let n = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method, auth: String((init?.headers as Record<string, string>).authorization) });
    if (String(url).endsWith("/user")) return Response.json({ login: "mybot" });
    if (String(url).endsWith("/installation")) return Response.json({ id: 77 });
    if (String(url).endsWith("/app/installations/77/access_tokens")) return Response.json({ token: `ghs_install${++n}`, expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("identity", () => {
  test("default: only BUNKER_GH_TOKEN means the PAT, and nothing changes", async () => {
    const env: Record<string, string | undefined> = { BUNKER_GH_TOKEN: "github_pat_owner" };
    expect(identityKind(env)).toBe("pat");
    const g = fakeGithub();
    const id = await applyIdentity(env, "o/r", { fetch: g.fetch });
    expect(id.kind).toBe("pat");
    expect(env.BUNKER_GH_TOKEN).toBe("github_pat_owner");
    expect(g.calls).toEqual([]);
  });

  test("mints an installation token with a JWT signed by the App key", async () => {
    const k = await keyFile();
    const g = fakeGithub();
    const t = await mintAppToken({ appId: "123", keyPath: k.path, repo: "o/r", fetch: g.fetch });
    expect(t.token).toBe("ghs_install1");
    expect(g.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r/installation",
      "POST https://api.github.com/app/installations/77/access_tokens",
    ]);
    const jwt = g.calls[0]!.auth.replace("Bearer ", "");
    const [h, p, s] = jwt.split(".");
    const v = createVerify("RSA-SHA256").update(`${h}.${p}`);
    expect(v.verify(k.publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  test("app identity replaces BUNKER_GH_TOKEN and refreshes before expiry", async () => {
    const k = await keyFile();
    const env: Record<string, string | undefined> = { BUNKER_GH_TOKEN: "github_pat_owner", BUNKER_APP_ID: "123", BUNKER_APP_PRIVATE_KEY_PATH: k.path };
    expect(identityKind(env)).toBe("app");
    const g = fakeGithub(1); // expires in 1s: refresh is due at once
    const id = await applyIdentity(env, "o/r", { fetch: g.fetch, refreshMarginMs: 900 });
    expect(env.BUNKER_GH_TOKEN).toBe("ghs_install1");
    await Bun.sleep(300);
    expect(env.BUNKER_GH_TOKEN).not.toBe("ghs_install1");
    expect(env.BUNKER_GH_TOKEN).toMatch(/^ghs_install\d+$/);
    id.stop();
  });

  test("a failing mint is an error naming the problem, not a silent fall back to the PAT", async () => {
    const k = await keyFile();
    const env: Record<string, string | undefined> = { BUNKER_GH_TOKEN: "github_pat_owner", BUNKER_APP_ID: "123", BUNKER_APP_PRIVATE_KEY_PATH: k.path };
    const fetch = (async () => new Response("bad", { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(applyIdentity(env, "o/r", { fetch })).rejects.toThrow(/installation/);
    expect(env.BUNKER_GH_TOKEN).toBe("github_pat_owner");
  });

  test("bot account: its own PAT variable becomes the token", async () => {
    const env: Record<string, string | undefined> = { BUNKER_GH_TOKEN: "github_pat_owner", BUNKER_BOT_GH_TOKEN: "github_pat_bot" };
    expect(identityKind(env)).toBe("bot");
    await applyIdentity(env, "o/r", { fetch: fakeGithub().fetch });
    expect(env.BUNKER_GH_TOKEN).toBe("github_pat_bot");
  });

  test("bot account: an unresolvable login fails closed and leaves the PAT in place", async () => {
    const env: Record<string, string | undefined> = { BUNKER_GH_TOKEN: "github_pat_owner", BUNKER_BOT_GH_TOKEN: "github_pat_bot" };
    const fetch = (async () => new Response("no", { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(applyIdentity(env, "o/r", { fetch })).rejects.toThrow(/bot account/);
    expect(env.BUNKER_IDENTITY_LOGIN).toBeUndefined();
    expect(env.BUNKER_GH_TOKEN).toBe("github_pat_owner");
  });

  test("bot account: the resolved login is recorded", async () => {
    const env: Record<string, string | undefined> = { BUNKER_BOT_GH_TOKEN: "github_pat_bot" };
    await applyIdentity(env, "o/r", { fetch: fakeGithub().fetch });
    expect(env.BUNKER_IDENTITY_LOGIN).toBe("mybot");
  });

  test("liveGhEnv follows a refreshed token for every later gh call", async () => {
    const env: Record<string, string | undefined> = { BUNKER_GH_TOKEN: "ghs_old", PATH: process.env.PATH };
    const live = liveGhEnv(env);
    expect(live.GH_TOKEN).toBe("ghs_old");
    env.BUNKER_GH_TOKEN = "ghs_new";
    expect(live.GH_TOKEN).toBe("ghs_new");
    expect(live.BUNKER_GH_TOKEN).toBe("ghs_new");
    const out = await Bun.$`sh -c 'echo $GH_TOKEN'`.env(live).text();
    expect(out.trim()).toBe("ghs_new");
    expect(liveGhEnv({ PATH: "x" }).GH_TOKEN).toBeUndefined();
  });

  test("runQueue and runIssueInner build their env with liveGhEnv, not a snapshot", async () => {
    for (const f of ["src/pipeline/queue.ts", "src/pipeline/issue-run.ts"]) {
      const src = await Bun.file(join(import.meta.dir, "..", f)).text();
      expect(src).toContain("liveGhEnv()");
      expect(src).not.toMatch(/\.\.\.process\.env, GH_TOKEN/);
    }
  });

  test("the key and bot token never reach a sandbox, and are redacted", () => {
    const keys = ["BUNKER_APP_ID", "BUNKER_APP_PRIVATE_KEY_PATH", "BUNKER_BOT_GH_TOKEN"];
    for (const k of keys) process.env[k] = "secretvalue-" + k;
    try {
      const e = agentEnv();
      for (const k of keys) expect(e[k]).toBeUndefined();
      expect(redact("x secretvalue-BUNKER_BOT_GH_TOKEN y")).toBe("x [REDACTED] y");
    } finally {
      for (const k of keys) delete process.env[k];
    }
  });

  test("trust keys on the human maintainer, never the bot", async () => {
    const info = {
      author: { login: "bunker-dbggr[bot]" },
      bodyTrusted: false,
      comments: [{ author: { login: "bunker-dbggr[bot]" }, authorAssociation: "OWNER", body: "x", trusted: false }],
    } as any;
    await markTrust(info, process.cwd(), { BUNKER_IDENTITY_LOGIN: "" });
    expect(info.bodyTrusted).toBe(false);
    expect(info.comments[0].trusted).toBe(false);
    const bot = { author: { login: "mybot" }, bodyTrusted: false, comments: [{ author: { login: "mybot" }, authorAssociation: "OWNER", body: "x", trusted: false }] } as any;
    await markTrust(bot, process.cwd(), { BUNKER_IDENTITY_LOGIN: "mybot" });
    expect(bot.bodyTrusted).toBe(false);
    expect(bot.comments[0].trusted).toBe(false);
  });
});
