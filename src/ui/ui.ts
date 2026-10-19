import type { Server } from "bun";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redact } from "../core/redact.ts";
import type { BunkerEvent, OnEvent } from "../core/events.ts";
import page from "./ui.html" with { type: "text" };

export interface Hub {
  /** e.g. http://127.0.0.1:4321 */
  url: string;
  /** `url` plus the access key the page and socket need, e.g. http://127.0.0.1:4321/?k=... */
  viewUrl: string;
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
/** The hub port used when --port isn't given: BUNKER_HUB_PORT if set to a valid port (tests point it away from a developer's live hub), else 4321. */
export function defaultHubPort(): number {
  const raw = process.env.BUNKER_HUB_PORT;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}
/** Most events the hub remembers per repo for late-joining pages. */
export const HISTORY_LIMIT = 2000;
/** Most distinct repos the hub keeps history for; the least recently active is evicted first. */
export const REPO_LIMIT = 100;
/** Events older than this are dropped from the on-disk history. */
export const HISTORY_MAX_AGE_MS = 7 * 86_400_000;
export const TOKEN_PATH = join(homedir(), ".config", "bunker", "ui.token");

/** Redacts every string field of an event. */
function clean(e: BunkerEvent): BunkerEvent {
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])) as unknown as BunkerEvent;
}

/** Where the hub keeps its per-repo JSONL history: $XDG_STATE_HOME/bunker/hub (default ~/.local/state/bunker/hub). */
export function hubHistoryDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "bunker", "hub");
}

/** File name for a repo's history; the repo id itself is stored in every line. */
const historyFile = (dir: string, repo: string) => join(dir, `${repo.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_")}.jsonl`);

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

/** Signed input is bound to the port and a fixed context, so a hub can't be used as a signing oracle for other purposes. */
const proof = (token: string, port: number, nonce: string) => createHmac("sha256", token).update(`bunker-hub:health:${port}:${nonce}`).digest("hex");

/** Key the page and socket require to read events; derived from the token, so it differs per token and port. */
const viewKey = (token: string, port: number) => createHmac("sha256", token).update(`bunker-hub:view:${port}`).digest("hex");

/** The URL to open the live view of the hub on `port`. */
export const viewUrlFor = (port: number, token: string) => `http://${HOST}:${port}/?k=${viewKey(token, port)}`;

/**
 * The shared live view. Always binds to loopback; there is no option to change that.
 * The page and socket are read-only; the one write is POST /publish, which needs the token.
 */
export function startHub({ port = defaultHubPort(), token, historyLimit = HISTORY_LIMIT, repoLimit = REPO_LIMIT, historyDir, maxAgeMs = HISTORY_MAX_AGE_MS }: { port?: number; token: string; historyLimit?: number; repoLimit?: number; historyDir?: string; maxAgeMs?: number }): Hub {
  // Replayed to late clients; capped per repo so one busy repo can't evict the rest.
  const history = new Map<string, { seq: number; msg: string; t: number; kind?: string | undefined }[]>();
  let seq = 0;

  /** Adds an already-cleaned event to the in-memory history, applying the caps. Returns the entry. */
  const add = (repo: string, ev: any, msg: string, t: number) => {
    const list = history.get(repo) ?? [];
    // A late page needs only the latest usage per run and the latest budget; keeping every one would push results out of the history.
    const kind = ev.type === "budget" ? "budget" : ev.type === "usage" || ev.type === "result" ? `run:${ev.issue}:${ev.task}` : undefined;
    if (kind) for (let n = list.length - 1; n >= 0; n--) if (list[n]!.kind === (ev.type === "budget" ? "budget" : kind)) list.splice(n, 1);
    // Re-insert so Map order runs from least to most recently active.
    history.delete(repo);
    history.set(repo, list);
    while (history.size > repoLimit) {
      const evicted = history.keys().next().value!;
      history.delete(evicted);
      if (historyDir) rmSync(historyFile(historyDir, evicted), { force: true });
    }
    const entry = { seq: seq++, msg, t, ...(ev.type === "budget" || ev.type === "usage" ? { kind } : {}) };
    list.push(entry);
    if (list.length > historyLimit) list.splice(0, list.length - historyLimit);
    return list;
  };
  const lineOf = (repo: string, e: { msg: string; t: number }) => JSON.stringify({ t: e.t, repo, event: JSON.parse(e.msg).event }) + "\n";
  const compact = (repo: string) => {
    const file = historyFile(historyDir!, repo);
    writeFileSync(file, (history.get(repo) ?? []).map((e) => lineOf(repo, e)).join(""), { mode: 0o600 });
    chmodSync(file, 0o600);
  };
  const appended = new Map<string, number>();

  if (historyDir) {
    try {
      mkdirSync(historyDir, { recursive: true, mode: 0o700 });
      const cutoff = Date.now() - maxAgeMs;
      const rows: { t: number; repo: string; event: any }[] = [];
      const files = readdirSync(historyDir).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        for (const line of readFileSync(join(historyDir, f), "utf8").split("\n")) {
          try {
            const r = JSON.parse(line);
            if (typeof r?.t === "number" && typeof r.repo === "string" && r.repo && r.event && typeof r.event.type === "string" && r.t >= cutoff) rows.push(r);
          } catch {}
        }
      }
      rows.sort((a, b) => a.t - b.t);
      // Replayed through the same path as live events, and cleaned again so nothing unredacted survives.
      for (const r of rows) add(r.repo, r.event, JSON.stringify({ repo: r.repo, event: clean(r.event) }), r.t);
      // Compact: rewrite what survived the caps, drop files left with nothing.
      for (const f of files) rmSync(join(historyDir, f), { force: true });
      for (const repo of history.keys()) compact(repo);
    } catch {
      // History is a convenience; an unreadable directory must not stop the hub.
    }
  }

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
        const list = add(repo, body.event, msg, Date.now());
        if (historyDir) {
          try {
            const file = historyFile(historyDir, repo);
            mkdirSync(historyDir, { recursive: true, mode: 0o700 });
            const fresh = !existsSync(file);
            appendFileSync(file, lineOf(repo, list[list.length - 1]!), { mode: 0o600 });
            if (fresh) chmodSync(file, 0o600);
            // Keep the file near the in-memory size.
            const n = (appended.get(repo) ?? 0) + 1;
            appended.set(repo, n);
            if (n > historyLimit) {
              compact(repo);
              appended.set(repo, 0);
            }
          } catch {}
        }
        server.publish("events", msg);
        return new Response(null, { status: 204 });
      }
      if (req.method !== "GET") return new Response("read-only", { status: 405 });
      // Challenge-response: proves we hold the token without revealing it.
      if (url.pathname === "/health") return new Response(proof(token, srv.port!, url.searchParams.get("nonce") ?? ""));
      // Reading events needs the view key, so other local users on a shared host can't watch.
      if (!same(url.searchParams.get("k") ?? "", viewKey(token, srv.port!))) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/") return new Response(page as unknown as string, { headers: { "content-type": "text/html; charset=utf-8" } });
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
    viewUrl: viewUrlFor(server.port!, token),
    server,
    stop: async () => void (await server.stop(true)),
  };
}

/** Is a genuine hub (one that holds our token) listening on this port? The token itself is never sent. */
export async function hubReachable(port: number, token: string): Promise<boolean> {
  try {
    const nonce = randomBytes(16).toString("hex");
    const res = await fetch(`http://${HOST}:${port}/health?nonce=${nonce}`, { signal: AbortSignal.timeout(1000) });
    return same(await res.text(), proof(token, port, nonce));
  } catch {
    return false;
  }
}

/** A publisher for a reachable hub, or undefined when none is running. Delivery failures are swallowed. */
export async function connectHub({ port = defaultHubPort(), repo, token }: { port?: number; repo: string; token: string }): Promise<Publisher | undefined> {
  if (!(await hubReachable(port, token))) return undefined;
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
