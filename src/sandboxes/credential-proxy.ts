/**
 * A reverse proxy for api.anthropic.com that runs in bunker (on the host), so the agent container never holds the
 * real Claude credential: it gets a random placeholder and `ANTHROPIC_BASE_URL` pointing here, and the proxy swaps
 * the real credential in. It only ever talks to one upstream host; a request that would reach any other host is refused.
 */

export const ANTHROPIC_HOST = "api.anthropic.com";

export interface CredentialProxyOptions {
  /** Real credentials by env var name (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY). */
  credentials: { CLAUDE_CODE_OAUTH_TOKEN?: string; ANTHROPIC_API_KEY?: string };
  /** Interface to listen on: the agent network's gateway, never all interfaces. */
  hostname: string;
  port?: number;
  /** Upstream origin. Defaults to https://api.anthropic.com; only its host `api.anthropic.com` may receive credentials. */
  upstream?: string;
  /** Seconds a connection may sit idle before Bun closes it. Defaults to 0 (never): a model that thinks for a while sends nothing, and Bun's own 10 s default cut those streams. */
  idleTimeout?: number;
  /** Replaces fetch, for tests. */
  fetch?: (req: Request) => Promise<Response>;
}

export interface CredentialProxy {
  url: string;
  /** What the agent gets in place of each credential; the proxy accepts only these. */
  placeholders: { CLAUDE_CODE_OAUTH_TOKEN: string; ANTHROPIC_API_KEY: string };
  stop(): void;
}

const HOP = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "authorization", "x-api-key"];

export function startCredentialProxy(opts: CredentialProxyOptions): CredentialProxy {
  const upstream = opts.upstream ?? `https://${ANTHROPIC_HOST}`;
  const secret = crypto.randomUUID().replace(/-/g, "");
  const placeholders = {
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-bunker-placeholder-${secret}`,
    ANTHROPIC_API_KEY: `sk-ant-api03-bunker-placeholder-${secret}`,
  };
  const send = opts.fetch ?? ((r: Request) => fetch(r));
  const server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port ?? 0,
    idleTimeout: opts.idleTimeout ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname + url.search;
      // "//evil.com/x" or an absolute-form target must not move the request to another host.
      const target = new URL(upstream.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`));
      if (!path.startsWith("/") || path.startsWith("//") || target.host !== new URL(upstream).host) {
        return new Response("bunker credential proxy: refused", { status: 403 });
      }
      if (target.hostname !== ANTHROPIC_HOST && !opts.fetch) return new Response("bunker credential proxy: refused", { status: 403 });
      const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const key = req.headers.get("x-api-key");
      const headers = new Headers();
      for (const [k, v] of req.headers) if (!HOP.includes(k.toLowerCase())) headers.set(k, v);
      const { CLAUDE_CODE_OAUTH_TOKEN: oauth, ANTHROPIC_API_KEY: apiKey } = opts.credentials;
      if (bearer === placeholders.CLAUDE_CODE_OAUTH_TOKEN && oauth) headers.set("authorization", `Bearer ${oauth}`);
      else if (key === placeholders.ANTHROPIC_API_KEY && apiKey) headers.set("x-api-key", apiKey);
      else return new Response("bunker credential proxy: unauthorized", { status: 401 });
      const up = await send(new Request(target.href, { method: req.method, headers, body: req.body, redirect: "manual" }));
      // fetch has already decoded the body: the encoding and length headers would no longer match it.
      const out = new Headers(up.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
    },
  });
  server.unref();
  return { url: `http://${opts.hostname}:${server.port}`, placeholders, stop: () => void server.stop(true) };
}
