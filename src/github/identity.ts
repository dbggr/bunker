import { createSign } from "node:crypto";
import { addSecrets } from "../core/redact.ts";

type Env = Record<string, string | undefined>;
type Fetch = typeof globalThis.fetch;

export type IdentityKind = "pat" | "app" | "bot";

const API = "https://api.github.com";
/** Installation tokens live 1 h; renew this long before they expire. */
const REFRESH_MARGIN_MS = 10 * 60_000;

/** Which GitHub identity bunker acts as: the owner's PAT unless a GitHub App or a bot account's PAT is configured. */
export function identityKind(env: Env): IdentityKind {
  if (env.BUNKER_APP_ID && env.BUNKER_APP_PRIVATE_KEY_PATH) return "app";
  if (env.BUNKER_BOT_GH_TOKEN) return "bot";
  return "pat";
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

async function appJwt(appId: string, keyPath: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const sig = createSign("RSA-SHA256").update(body).sign(await Bun.file(keyPath).text());
  return `${body}.${sig.toString("base64url")}`;
}

async function call(fetch: Fetch, what: string, url: string, auth: string, method = "GET"): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method, headers: { authorization: auth, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "bunker" } });
  if (!res.ok) throw new Error(`GitHub App: ${what} failed (${res.status})`);
  return (await res.json()) as Record<string, unknown>;
}

/** Mints an installation access token for the App on `repo` (owner/name). */
export async function mintAppToken(o: { appId: string; keyPath: string; repo: string; fetch?: Fetch }): Promise<{ token: string; expiresAt: number }> {
  const fetch = o.fetch ?? globalThis.fetch;
  const auth = `Bearer ${await appJwt(o.appId, o.keyPath)}`;
  const inst = await call(fetch, `finding the installation for ${o.repo}`, `${API}/repos/${o.repo}/installation`, auth);
  const t = await call(fetch, "minting an installation token", `${API}/app/installations/${inst.id}/access_tokens`, auth, "POST");
  return { token: String(t.token), expiresAt: Date.parse(String(t.expires_at)) };
}

/**
 * Makes `env.BUNKER_GH_TOKEN` the token of the configured identity, so every gh/git call acts as it. The default (the owner's PAT)
 * is left untouched. An App's installation token is renewed before it expires. Throws if the identity can't be set up.
 */
export async function applyIdentity(env: Env, repo: string, opts: { fetch?: Fetch; refreshMarginMs?: number } = {}): Promise<{ kind: IdentityKind; stop(): void }> {
  const kind = identityKind(env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  if (kind === "bot") {
    env.BUNKER_GH_TOKEN = env.BUNKER_BOT_GH_TOKEN;
    try {
      const me = await call(opts.fetch ?? globalThis.fetch, "reading the bot account", `${API}/user`, `Bearer ${env.BUNKER_BOT_GH_TOKEN}`);
      if (me.login) env.BUNKER_IDENTITY_LOGIN = String(me.login);
    } catch {}
  } else if (kind === "app") {
    const margin = opts.refreshMarginMs ?? REFRESH_MARGIN_MS;
    const mint = async () => {
      const t = await mintAppToken({ appId: env.BUNKER_APP_ID!, keyPath: env.BUNKER_APP_PRIVATE_KEY_PATH!, repo, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
      addSecrets([t.token]);
      env.BUNKER_GH_TOKEN = t.token;
      return t.expiresAt;
    };
    const schedule = (expiresAt: number) => {
      if (stopped) return;
      timer = setTimeout(async () => {
        try {
          schedule(await mint());
        } catch {
          if (!stopped) timer = setTimeout(() => schedule(Date.now()), 30_000).unref();
        }
      }, Math.max(0, expiresAt - margin - Date.now()));
      timer.unref();
    };
    schedule(await mint());
  }
  return { kind, stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
