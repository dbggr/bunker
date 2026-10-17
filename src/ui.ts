import type { Server } from "bun";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redact } from "./redact.ts";
import type { BunkerEvent, OnEvent } from "./events.ts";
import page from "./ui.html" with { type: "text" };

export interface Hub {
  /** e.g. http://127.0.0.1:4321 */
  url: string;
  server: Server<unknown>;
  stop: () => Promise<void>;
}

/** A run's handle on a hub: its events go there, tagged with the repo. */
export interface Publisher {
  onEvent: OnEvent;
  /** Resolves once everything published so far has been delivered (or dropped). */
  flush: () => Promise<void>;
}

const HOST = "127.0.0.1";
export const DEFAULT_PORT = 4321;
/** Most events the hub remembers per repo for late-joining pages. */
export const HISTORY_LIMIT = 2000;
export const TOKEN_PATH = join(homedir(), ".config", "bunker", "ui.token");

/** Redacts every string field of an event. */
function clean(e: BunkerEvent): BunkerEvent {
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])) as unknown as BunkerEvent;
}

/** The publish token; created (0600) on first use. Browsers never get it. */
export function readToken(path = TOKEN_PATH): string {
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {}
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, token + "\n", { mode: 0o600, flag: "wx" });
  } catch {
    // Lost a creation race (or the file was empty): use whatever is there now.
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
    writeFileSync(path, token + "\n", { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return token;
}

/** `owner/repo` from an origin URL, falling back to the folder name. */
export function repoIdFromUrl(url: string | undefined, dir: string): string {
  const m = url?.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : basename(dir);
}

export async function repoId(dir = process.cwd()): Promise<string> {
  const p = Bun.spawn(["git", "-C", dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return repoIdFromUrl(p.exitCode === 0 ? out : undefined, dir);
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The shared live view. Always binds to loopback; there is no option to change that.
 * The page and socket are read-only; the one write is POST /publish, which needs the token.
 */
export function startHub({ port = DEFAULT_PORT, token, historyLimit = HISTORY_LIMIT }: { port?: number; token: string; historyLimit?: number }): Hub {
  // Replayed to late clients; capped per repo so one busy repo can't evict the rest.
  const history = new Map<string, { seq: number; msg: string }[]>();
  let seq = 0;
  const server = Bun.serve({
    hostname: HOST,
    port,
    maxRequestBodySize: 1 << 20,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // Refuse foreign Host/Origin so a web page can't reach us via DNS rebinding.
      const allowed = (h: string) => h === `${HOST}:${srv.port}` || h === `localhost:${srv.port}`;
      if (!allowed(req.headers.get("host") ?? "")) return new Response("forbidden", { status: 403 });
      const origin = req.headers.get("origin");
      if (origin && !allowed(origin.replace(/^https?:\/\//, ""))) return new Response("forbidden", { status: 403 });
      if (url.pathname === "/publish") {
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        const auth = req.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer ") || !same(auth.slice(7), token)) return new Response("unauthorized", { status: 401 });
        let body: any;
        try {
          body = await req.json();
        } catch {
          return new Response("bad request", { status: 400 });
        }
        if (typeof body?.repo !== "string" || !body.repo || typeof body.event !== "object" || !body.event || typeof body.event.type !== "string") {
          return new Response("bad request", { status: 400 });
        }
        const repo = redact(body.repo);
        const msg = JSON.stringify({ repo, event: clean(body.event) });
        const list = history.get(repo) ?? [];
        history.set(repo, list);
        list.push({ seq: seq++, msg });
        if (list.length > historyLimit) list.splice(0, list.length - historyLimit);
        server.publish("events", msg);
        return new Response(null, { status: 204 });
      }
      if (req.method !== "GET") return new Response("read-only", { status: 405 });
      if (url.pathname === "/") return new Response(page as unknown as string, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/health") return new Response("bunker-hub");
      if (url.pathname === "/events" && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("events");
        for (const { msg } of [...history.values()].flat().sort((a, b) => a.seq - b.seq)) ws.send(msg);
      },
      // Read-only: anything a client sends is ignored.
      message() {},
    },
  });
  return {
    url: `http://${HOST}:${server.port}`,
    server,
    stop: async () => void (await server.stop(true)),
  };
}

/** Is a hub listening on this port? */
export async function hubReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return (await res.text()) === "bunker-hub";
  } catch {
    return false;
  }
}

/** A publisher for a reachable hub, or undefined when none is running. Delivery failures are swallowed. */
export async function connectHub({ port = DEFAULT_PORT, repo, token }: { port?: number; repo: string; token: string }): Promise<Publisher | undefined> {
  if (!(await hubReachable(port))) return undefined;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    onEvent(event) {
      const body = JSON.stringify({ repo, event });
      chain = chain.then(() =>
        fetch(`http://${HOST}:${port}/publish`, { method: "POST", body, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {}),
      );
    },
    flush: async () => void (await chain),
  };
}
