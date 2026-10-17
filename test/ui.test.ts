import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHub, hubReachable, readToken, repoIdFromUrl, startHub, type Hub } from "../src/ui.ts";

setDefaultTimeout(60_000); // see test/setup.ts

let hub: Hub | undefined;
afterEach(async () => {
  await hub?.stop();
  hub = undefined;
});

const TOKEN = "t".repeat(32);
const connect = (url: string) =>
  new Promise<{ ws: WebSocket; messages: any[] }>((resolve, reject) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/events");
    const messages: any[] = [];
    ws.onmessage = (m) => messages.push(JSON.parse(String(m.data)));
    ws.onopen = () => resolve({ ws, messages });
    ws.onerror = () => reject(new Error("ws error"));
  });
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(20);
  expect(f()).toBe(true);
};
const publish = (url: string, body: unknown, token?: string) =>
  fetch(url + "/publish", { method: "POST", body: JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("startHub()", () => {
  test("loopback only, serves a tabbed page", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(hub.server.hostname).toBe("127.0.0.1");
    const res = await fetch(hub.url + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const s of ["WebSocket", "waiting for merge", "location.hash", "tabs"]) expect(html).toContain(s);
    expect(html).not.toContain(TOKEN);
  });

  test("there is no way to bind a non-loopback address", () => {
    hub = startHub({ port: 0, token: TOKEN, hostname: "0.0.0.0" } as any);
    expect(hub.server.hostname).toBe("127.0.0.1");
  });

  test("two repos' events reach one client, tagged and redacted; late clients get history", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const early = await connect(hub.url);
    expect((await publish(hub.url, { repo: "a/one", event: { type: "text", issue: 1, text: "key sk-ant-secret123 x", at: 1 } }, TOKEN)).status).toBe(204);
    expect((await publish(hub.url, { repo: "b/two", event: { type: "stage", issue: 2, name: "implement", at: 2 } }, TOKEN)).status).toBe(204);
    await until(() => early.messages.length === 2);
    expect(early.messages.map((m) => m.repo)).toEqual(["a/one", "b/two"]);
    expect(early.messages[0].event.text).toBe("key [REDACTED] x");
    const late = await connect(hub.url);
    await until(() => late.messages.length === 2);
    early.ws.close();
    late.ws.close();
  });

  test("history is capped per repo, keeping the newest events in order", async () => {
    hub = startHub({ port: 0, token: TOKEN, historyLimit: 3 });
    for (let i = 1; i <= 5; i++) {
      await publish(hub.url, { repo: "a/one", event: { type: "stage", issue: 1, name: `s${i}`, at: i } }, TOKEN);
      if (i === 2) await publish(hub.url, { repo: "b/two", event: { type: "stage", issue: 2, name: "only", at: 10 } }, TOKEN);
    }
    const late = await connect(hub.url);
    await until(() => late.messages.length === 4);
    await Bun.sleep(50);
    expect(late.messages.map((m) => m.event.name)).toEqual(["only", "s3", "s4", "s5"]);
    late.ws.close();
  });

  test("history evicts the least recently active repo past the repo cap", async () => {
    hub = startHub({ port: 0, token: TOKEN, repoLimit: 2 });
    const ev = (name: string) => ({ type: "stage", issue: 1, name, at: 1 });
    await publish(hub.url, { repo: "a/one", event: ev("a1") }, TOKEN);
    await publish(hub.url, { repo: "b/two", event: ev("b1") }, TOKEN);
    await publish(hub.url, { repo: "a/one", event: ev("a2") }, TOKEN);
    await publish(hub.url, { repo: "c/three", event: ev("c1") }, TOKEN);
    const late = await connect(hub.url);
    await until(() => late.messages.length === 3);
    await Bun.sleep(50);
    expect(late.messages.map((m) => m.event.name)).toEqual(["a1", "a2", "c1"]);
    late.ws.close();
  });

  test("publish without or with a wrong token is rejected and not broadcast", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const c = await connect(hub.url);
    const body = { repo: "a/one", event: { type: "text", text: "hi", at: 1 } };
    expect((await publish(hub.url, body)).status).toBe(401);
    expect((await publish(hub.url, body, "wrong")).status).toBe(401);
    expect((await publish(hub.url, body, TOKEN + "x")).status).toBe(401);
    await Bun.sleep(100);
    expect(c.messages).toEqual([]);
    c.ws.close();
  });

  test("malformed publishes are rejected", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    expect((await publish(hub.url, { nope: 1 }, TOKEN)).status).toBe(400);
    expect((await fetch(hub.url + "/publish", { method: "POST", body: "{", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(400);
  });

  test("read-only: only GET /, /health, the socket and token-authenticated POST /publish exist", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    for (const method of ["POST", "PUT", "DELETE"]) expect((await fetch(hub.url + "/", { method })).status).toBe(405);
    expect((await fetch(hub.url + "/publish")).status).toBe(405);
    expect((await fetch(hub.url + "/nope")).status).toBe(404);
  });

  test("a client's socket messages change nothing", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const a = await connect(hub.url);
    const b = await connect(hub.url);
    a.ws.send(JSON.stringify({ repo: "x/y", event: { type: "text", at: 1 } }));
    await Bun.sleep(100);
    expect(b.messages).toEqual([]);
    a.ws.close();
    b.ws.close();
  });

  test("rejects a foreign Host header and a foreign Origin (DNS rebinding)", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    expect((await fetch(hub.url + "/", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await fetch(hub.url + "/health", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await fetch(hub.url + "/publish", { method: "POST", headers: { Host: "evil.example", authorization: `Bearer ${TOKEN}` }, body: "{}" })).status).toBe(403);
    expect((await fetch(hub.url + "/", { headers: { Origin: "http://evil.example" } })).status).toBe(403);
  });

  test("stop() closes the server", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const url = hub.url;
    await hub.stop();
    hub = undefined;
    expect(fetch(url + "/").then(() => "up", () => "down")).resolves.toBe("down");
  });
});

describe("connectHub()", () => {
  test("publishes a run's events, in order, to a reachable hub", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const c = await connect(hub.url);
    const pub = await connectHub({ port: hub.server.port!, repo: "a/one", token: TOKEN });
    expect(pub).toBeDefined();
    for (let i = 1; i <= 5; i++) pub!.onEvent({ type: "text", issue: 1, text: String(i), at: i });
    await until(() => c.messages.length === 5);
    expect(c.messages.map((m) => m.event.text)).toEqual(["1", "2", "3", "4", "5"]);
    expect(c.messages.every((m) => m.repo === "a/one")).toBe(true);
    c.ws.close();
  });

  test("flush delivers queued closing events (awaited before every process.exit in the CLI)", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const c = await connect(hub.url);
    const pub = await connectHub({ port: hub.server.port!, repo: "a/one", token: TOKEN });
    pub!.onEvent({ type: "text", text: "failed", at: 1 });
    await pub!.flush();
    await until(() => c.messages.length === 1);
    expect(c.messages.map((m) => m.event.text)).toEqual(["failed"]);
    c.ws.close();
  });

  test("no hub running: returns undefined, no errors", async () => {
    // A port kept bound by a listener that drops every connection: a freed port could be rebound by a hub in another
    // test process (e.g. a parallel verify running this suite) before connectHub checks it.
    const dead = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (s) => void s.end(), data() {} } });
    try {
      expect(await connectHub({ port: dead.port, repo: "a/one", token: TOKEN })).toBeUndefined();
    } finally {
      dead.stop(true);
    }
  });

  test("hub vanishing mid-run is swallowed", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const pub = await connectHub({ port: hub.server.port!, repo: "a/one", token: TOKEN });
    await hub.stop();
    hub = undefined;
    expect(() => pub!.onEvent({ type: "text", text: "x", at: 1 })).not.toThrow();
    await pub!.flush();
  });

  test("a hub with a different token is not trusted", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    expect(await connectHub({ port: hub.server.port!, repo: "a/one", token: "bad" })).toBeUndefined();
  });

  test("an impostor that answers 'bunker-hub' never receives the token", async () => {
    const seen: string[] = [];
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        return new Response("bunker-hub");
      },
    });
    try {
      expect(await hubReachable(fake.port!, TOKEN)).toBe(false);
      expect(await connectHub({ port: fake.port!, repo: "a/one", token: TOKEN })).toBeUndefined();
      expect(seen.every((a) => a === "")).toBe(true);
    } finally {
      await fake.stop(true);
    }
  });
});

describe("readToken()", () => {
  test("creates a random 0600 token once and reuses it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bunker-tok-")), "sub", "ui.token");
    const a = readToken(path);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readToken(path)).toBe(a);
    expect(readFileSync(path, "utf8").trim()).toBe(a);
  });
});

describe("repoIdFromUrl()", () => {
  test("owner/repo from https and ssh origins, else the folder name", () => {
    expect(repoIdFromUrl("https://github.com/acme/widgets.git", "/x/dir")).toBe("acme/widgets");
    expect(repoIdFromUrl("git@github.com:acme/widgets.git", "/x/dir")).toBe("acme/widgets");
    expect(repoIdFromUrl("https://github.com/acme/widgets", "/x/dir")).toBe("acme/widgets");
    expect(repoIdFromUrl("", "/x/dir")).toBe("dir");
    expect(repoIdFromUrl(undefined, "/x/dir")).toBe("dir");
  });
});
