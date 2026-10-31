import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHub, ensureHub, hubReachable, readToken, repoIdFromUrl, startHub, type Hub } from "../src/ui/ui.ts";

setDefaultTimeout(60_000); // see test/setup.ts

let hub: Hub | undefined;
afterEach(async () => {
  await hub?.stop();
  hub = undefined;
});

const TOKEN = "t".repeat(32);
const connect = (viewUrl: string) =>
  new Promise<{ ws: WebSocket; messages: any[] }>((resolve, reject) => {
    const u = new URL(viewUrl.replace("http", "ws"));
    u.pathname = "/events";
    const ws = new WebSocket(u.href);
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

describe("startHub() access control", () => {
  test("the page and socket need the view key; /health does not", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    expect((await fetch(hub.url + "/")).status).toBe(401);
    expect((await fetch(hub.url + "/?k=wrong")).status).toBe(401);
    expect((await fetch(hub.url + "/health?nonce=x")).status).toBe(200);
    expect(hub.viewUrl).not.toContain(TOKEN);
    await expect(connect(hub.url)).rejects.toThrow();
  });

  test("/health signs the port and a fixed context, not just the nonce", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const nonce = "abc";
    const body = await (await fetch(hub.url + "/health?nonce=" + nonce)).text();
    const { createHmac } = await import("node:crypto");
    expect(body).toBe(createHmac("sha256", TOKEN).update(`bunker-hub:health:${hub.server.port}:${nonce}`).digest("hex"));
    expect(body).not.toBe(createHmac("sha256", TOKEN).update(`bunker-hub:${nonce}`).digest("hex"));
  });
});

describe("startHub()", () => {
  test("loopback only, serves a tabbed page", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(hub.server.hostname).toBe("127.0.0.1");
    const res = await fetch(hub.viewUrl);
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
    const early = await connect(hub.viewUrl);
    expect((await publish(hub.url, { repo: "a/one", event: { type: "text", issue: 1, text: "key sk-ant-secret123 x", at: 1 } }, TOKEN)).status).toBe(204);
    expect((await publish(hub.url, { repo: "b/two", event: { type: "stage", issue: 2, name: "implement", at: 2 } }, TOKEN)).status).toBe(204);
    await until(() => early.messages.length === 2);
    expect(early.messages.map((m) => m.repo)).toEqual(["a/one", "b/two"]);
    expect(early.messages[0].event.text).toBe("key [REDACTED] x");
    const late = await connect(hub.viewUrl);
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
    const late = await connect(hub.viewUrl);
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
    const late = await connect(hub.viewUrl);
    await until(() => late.messages.length === 3);
    await Bun.sleep(50);
    expect(late.messages.map((m) => m.event.name)).toEqual(["a1", "a2", "c1"]);
    late.ws.close();
  });

  test("publish without or with a wrong token is rejected and not broadcast", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const c = await connect(hub.viewUrl);
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
    expect((await fetch(hub.viewUrl.replace("/?", "/nope?"))).status).toBe(404);
  });

  test("a client's socket messages change nothing", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const a = await connect(hub.viewUrl);
    const b = await connect(hub.viewUrl);
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
    const c = await connect(hub.viewUrl);
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
    const c = await connect(hub.viewUrl);
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

describe("hub replay of cost events", () => {
  test("a page opened mid-run gets the latest usage and budget, not every update", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    const ev = (e: object) => publish(hub!.url, { repo: "a/one", event: e }, TOKEN);
    await ev({ type: "stage", issue: 1, name: "implement", at: 1 });
    for (let i = 1; i <= 5; i++) await ev({ type: "usage", issue: 1, estCostUsd: i, at: 1 + i });
    for (let i = 1; i <= 3; i++) await ev({ type: "budget", budget: { day: { spentUsd: i }, month: { spentUsd: i } }, at: 10 + i });
    const late = await connect(hub.viewUrl);
    await until(() => late.messages.length === 3);
    await Bun.sleep(50);
    expect(late.messages.map((m) => m.event.type)).toEqual(["stage", "usage", "budget"]);
    expect(late.messages[1].event.estCostUsd).toBe(5);
    expect(late.messages[2].event.budget.day.spentUsd).toBe(3);
    late.ws.close();
  });

  test("usage updates don't evict the results that carry the exact cost", async () => {
    hub = startHub({ port: 0, token: TOKEN, historyLimit: 3 });
    const ev = (e: object) => publish(hub!.url, { repo: "a/one", event: e }, TOKEN);
    await ev({ type: "result", issue: 1, costUsd: 2, at: 1 });
    for (let i = 1; i <= 10; i++) await ev({ type: "usage", issue: 1, estCostUsd: i, at: 1 + i });
    const late = await connect(hub.viewUrl);
    await until(() => late.messages.length === 2);
    expect(late.messages.map((m) => m.event.type)).toEqual(["result", "usage"]);
    late.ws.close();
  });
});

describe("hub history on disk", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "bunker-hub-"));
  const replayed = async (h: Hub) => {
    const { ws, messages } = await connect(h.viewUrl);
    await Bun.sleep(100);
    ws.close();
    return messages;
  };
  const post = (h: Hub, repo: string, event: any) => publish(h.url, { repo, event }, TOKEN);

  test("a restart restores runs, budget and finished states; files are 0600 and redacted", async () => {
    const historyDir = dir();
    hub = startHub({ port: 0, token: TOKEN, historyDir });
    await post(hub, "o/r", { type: "budget", spent: 1 });
    await post(hub, "o/r", { type: "budget", spent: 2 });
    await post(hub, "o/r", { type: "usage", issue: 1, task: "a", cost: 1 });
    await post(hub, "o/r", { type: "result", issue: 1, task: "a", text: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789 done" });
    await hub.stop();
    const file = join(historyDir, "o_r.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    hub = startHub({ port: 0, token: TOKEN, historyDir });
    const msgs = await replayed(hub);
    expect(msgs.map((m) => m.event.type)).toEqual(["budget", "result"]);
    expect(msgs[0].event.spent).toBe(2);
    expect(msgs.every((m) => m.repo === "o/r")).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("caps hold on replay and the file is compacted", async () => {
    const historyDir = dir();
    hub = startHub({ port: 0, token: TOKEN, historyDir });
    for (let i = 0; i < 8; i++) await post(hub, "o/r", { type: "log", n: i });
    await hub.stop();
    hub = startHub({ port: 0, token: TOKEN, historyDir, historyLimit: 3 });
    expect((await replayed(hub)).map((m) => m.event.n)).toEqual([5, 6, 7]);
    expect(readFileSync(join(historyDir, "o_r.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("events older than the age limit are dropped", async () => {
    const historyDir = dir();
    const line = (t: number, n: number) => JSON.stringify({ t, repo: "o/r", event: { type: "log", n } });
    await Bun.write(join(historyDir, "o_r.jsonl"), [line(Date.now() - 8 * 86_400_000, 1), line(Date.now() - 1000, 2)].join("\n") + "\n");
    hub = startHub({ port: 0, token: TOKEN, historyDir });
    expect((await replayed(hub)).map((m) => m.event.n)).toEqual([2]);
    expect(readFileSync(join(historyDir, "o_r.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a corrupt line is skipped, not fatal", async () => {
    const historyDir = dir();
    const good = (n: number) => JSON.stringify({ t: Date.now(), repo: "o/r", event: { type: "log", n } });
    await Bun.write(join(historyDir, "o_r.jsonl"), [good(1), "{not json", '{"t":1}', good(2)].join("\n") + "\n");
    hub = startHub({ port: 0, token: TOKEN, historyDir });
    expect((await replayed(hub)).map((m) => m.event.n)).toEqual([1, 2]);
  });
});

describe("hub page model", () => {
  const load = async () => {
    const html = await Bun.file(new URL("../src/ui/ui.html", import.meta.url)).text();
    const code = /<script id="model">([\s\S]*?)<\/script>/.exec(html)![1]!;
    return new Function(code + "; return Model;")() as any;
  };
  const NOW = new Date(2026, 9, 19, 15, 0, 0).getTime();
  const ev = (e: object) => ({ at: NOW - 60_000, ...e });

  test("note events: queue order, blocked-by and shepherd text reach their panels", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ type: "note", text: "queue: #5 (high, bug) · #6 · #7 (low) (re-ordered)" }));
    M.ingest(r, ev({ type: "note", issue: 6, text: "blocked by #9: other thing" }));
    M.ingest(r, ev({ type: "note", issue: 3, text: "PR #12: CI failing, fixing" }));
    M.ingest(r, ev({ type: "stage", issue: 5, name: "implement" }));
    const q = M.queue(r);
    expect(q.map((x: any) => x.issue)).toEqual([6, 7]); // #5 started
    expect(q[0].blockedOn).toEqual({ number: 9, title: "other thing" });
    expect(q[1].tags).toEqual(["low"]);
    expect(M.shepherd(r)).toEqual([{ issue: 3, pr: 12, action: "note", detail: "CI failing, fixing" }]);
    // A watcher record of the PR wins over the note.
    M.ingest(r, ev({ type: "watcher", watcher: { version: "1", startedAt: 1, parallel: 1, merged: [], noChange: [], failed: [], shepherd: [{ issue: 3, pr: 12, action: "waiting" }] } }));
    expect(M.shepherd(r)[0].action).toBe("waiting");
  });

  const wsnap = (o: object) => ({ type: "watcher", watcher: { version: "1", startedAt: 1, parallel: 1, merged: [], noChange: [], failed: [], shepherd: [], ...o } });

  test("shepherd rows: state badge, link from owner/repo, snapshot is the source of truth", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ type: "note", issue: 3, text: "PR #12: green" }));
    M.ingest(r, ev({ type: "note", issue: 4, text: "PR #13: waiting: waiting for test" }));
    const rows = M.shepherd(r, "dbggr/bunker");
    expect(rows[0]).toMatchObject({ pr: 12, action: "green", detail: "", prUrl: "https://github.com/dbggr/bunker/pull/12" });
    expect(rows[1]).toMatchObject({ pr: 13, action: "waiting", detail: "waiting for test" });
    M.ingest(r, ev({ type: "stage", issue: 4, name: "merged" }));
    expect(M.shepherd(r, "dbggr/bunker").map((s: any) => s.pr)).toEqual([12]);
    M.ingest(r, ev(wsnap({ shepherd: [{ issue: 9, pr: 20, action: "green", prUrl: "http://pr/20" }] })));
    expect(M.shepherd(r, "dbggr/bunker")).toEqual([{ issue: 9, pr: 20, action: "green", prUrl: "http://pr/20" }]);
  });

  describe("today / all filter", () => {
    const DAY = 24 * 3600_000;
    const midnight = new Date(2026, 9, 19).getTime();
    const setup = async () => {
      const M = await load();
      const r = M.newRepo();
      const run = (issue: number, start: number, end?: number) => {
        M.ingest(r, { at: start, type: "stage", issue, name: "implement" });
        if (end !== undefined) M.ingest(r, { at: end, type: "stage", issue, name: "merged" });
      };
      run(1, NOW - 2 * DAY, NOW - 2 * DAY + 3600_000); // two days ago
      run(2, NOW - 3600_000, NOW - 1800_000); // today
      run(3, midnight - 3600_000, midnight + 3600_000); // finished across midnight
      run(4, NOW - DAY); // in flight since yesterday
      run(5, midnight - 7200_000, midnight - 3600_000); // yesterday
      return { M, r };
    };

    test("default shows today's finished runs plus in-flight ones from any day", async () => {
      const { M, r } = await setup();
      const g = M.groups(r, NOW);
      expect(g.finished.map((f: any) => f.issue).sort()).toEqual([2, 3]);
      expect(g.running.map((x: any) => x.key)).toEqual(["#4"]);
    });

    test("all shows the full history", async () => {
      const { M, r } = await setup();
      expect(M.groups(r, NOW, true).finished.map((f: any) => f.issue).sort()).toEqual([1, 2, 3, 5]);
    });

    test("tab counts follow the filter; idle merges today stay today-only", async () => {
      const M = await load();
      const r = M.newRepo();
      M.ingest(r, ev(wsnap({ failed: [{ issue: 8, status: "gave-up", reason: "x", at: NOW - 2 * DAY }] })));
      expect(M.tab(r, NOW).kind).toBe("idle");
      expect(M.tab(r, NOW, true)).toMatchObject({ kind: "failed", label: "1 failed" });
      const s = await setup();
      expect(s.M.idle(s.r, NOW).mergedToday).toBe(2);
    });

    test("page defaults to Today and remembers the choice in localStorage inside try/catch", async () => {
      const html = await Bun.file(new URL("../src/ui/ui.html", import.meta.url)).text();
      expect(html).toContain("let showAll = false");
      expect(html).toMatch(/try \{[^}]*localStorage\.getItem/);
      expect(html).toMatch(/try \{[^}]*localStorage\.setItem/);
      for (const t of ["Today", "All"]) expect(html).toContain(`"${t}"`);
    });
  });

  test("awaiting-merge run shows as a waiting card, then merged moves it to Finished today", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ type: "stage", issue: 4, name: "PR" }));
    M.ingest(r, ev({ type: "stage", issue: 4, name: "waiting for merge", text: "http://pr/4" }));
    let g = M.groups(r, NOW);
    expect([g.running.length, g.waiting.length, g.finished.length]).toEqual([0, 1, 0]);
    M.ingest(r, { at: NOW - 1000, type: "stage", issue: 4, name: "merged" });
    g = M.groups(r, NOW);
    expect([g.running.length, g.waiting.length]).toEqual([0, 0]);
    expect(g.finished.map((f: any) => [f.issue, f.outcome])).toEqual([[4, "merged"]]);
  });

  test("a missed stage event is healed by the watcher snapshot (merged and failed)", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ type: "stage", issue: 4, name: "PR" }));
    M.ingest(r, ev({ type: "stage", issue: 5, name: "waiting for merge" }));
    M.ingest(r, { at: NOW - 1000, ...wsnap({ merged: [{ issue: 4, prUrl: "http://pr/4", at: NOW - 1000 }], failed: [{ issue: 5, status: "gave-up", reason: "closed", at: NOW - 900 }] }) });
    const g = M.groups(r, NOW);
    expect([g.running.length, g.waiting.length]).toEqual([0, 0]);
    expect(g.finished.map((f: any) => [f.issue, f.outcome]).sort()).toEqual([[4, "merged"], [5, "failed"]]);
  });

  test("a watcher record from before the run started does not finish a new run", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, { at: NOW - 5000, ...wsnap({ failed: [{ issue: 4, status: "x", reason: "old", at: NOW - 70_000 }] }) });
    M.ingest(r, ev({ type: "stage", issue: 4, name: "implement" }));
    expect(M.groups(r, NOW).running.length).toBe(1);
  });

  test("manual mode: awaiting review is a waiting card, not running", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ type: "stage", issue: 4, name: "awaiting review" }));
    const g = M.groups(r, NOW);
    expect([g.running.length, g.waiting.length]).toEqual([0, 1]);
    expect(M.track("awaiting review")[5].state).toBe("current");
  });

  test("a run's notes land in its log; the stage track marks done/current/todo", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ type: "meta", issue: 1, title: "Fix it", logPath: "/l.log" }));
    M.ingest(r, ev({ type: "stage", issue: 1, name: "review", model: "opus", round: 2, role: "reviewer" }));
    M.ingest(r, ev({ type: "note", issue: 1, text: "verify passed (3 tests)" }));
    const x = r.runs.get("#1");
    expect(x.title).toBe("Fix it");
    expect(x.log.map((l: any) => l.kind)).toEqual(["stage", "note"]);
    expect(M.track("review").map((s: any) => s.state)).toEqual(["done", "done", "current", "todo", "todo", "todo"]);
    expect(M.track("merged").every((s: any) => s.state === "done")).toBe(true);
    expect(M.tab(r, NOW)).toMatchObject({ kind: "working", label: "1 running" });
  });

  test("finished list: today's merged/failed with reasons, merged from the run and the watcher", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ type: "meta", issue: 2, title: "Two" }));
    M.ingest(r, ev({ type: "stage", issue: 2, name: "failed", reason: "verify failed" }));
    M.ingest(r, ev({ type: "watcher", watcher: { version: "1", startedAt: 1, parallel: 1, merged: [{ issue: 4, prUrl: "http://pr/4", at: NOW - 1000 }, { issue: 8, at: NOW - 3 * 86_400_000 }], noChange: [], failed: [{ issue: 7, status: "x", reason: "gave up", at: NOW - 2000 }], shepherd: [] } }));
    const g = M.groups(r, NOW);
    expect(g.finished.map((f: any) => [f.issue, f.outcome, f.reason])).toEqual([[4, "merged", ""], [7, "failed", "gave up"], [2, "failed", "verify failed"]]);
    expect(g.idle).toBe(true);
    expect(M.tab(r, NOW)).toMatchObject({ kind: "failed", label: "2 failed" });
  });

  test("idle state: next pass, today's spend, merged today, last merge", async () => {
    const M = await load();
    const r = M.newRepo();
    expect(M.tab(r, NOW)).toMatchObject({ kind: "idle", label: "idle" });
    M.ingest(r, ev({ type: "budget", budget: { day: { spentUsd: 1.5, capUsd: 10 }, month: { spentUsd: 3 } } }));
    M.ingest(r, ev({ type: "watcher", watcher: { version: "1", startedAt: 1, parallel: 2, nextPassAt: NOW + 5000, merged: [{ issue: 4, prUrl: "http://pr/4", at: NOW - 1000 }], noChange: [], failed: [], shepherd: [] } }));
    expect(M.idle(r, NOW)).toEqual({ nextPassAt: NOW + 5000, spentToday: 1.5, mergedToday: 1, lastMerge: { issue: 4, prUrl: "http://pr/4", at: NOW - 1000 } });
    expect(M.watcherLive(r, NOW)).toBe(true);
  });

  test("spend bars: amber from 80%, red from 100%, against the cap in effect", async () => {
    const M = await load();
    const level = (spent: number, cap?: number) => {
      const r = M.newRepo();
      M.ingest(r, ev({ type: "budget", budget: { day: { spentUsd: spent, ...(cap ? { capUsd: cap } : {}) }, month: { spentUsd: 0 } } }));
      return M.spend(r).windows[0];
    };
    expect(level(7.9, 10).level).toBe("");
    expect(level(8, 10).level).toBe("warn");
    expect(level(10, 10).level).toBe("full");
    expect(level(5).frac).toBeUndefined();
  });

  test("repoLinks: an owner/repo tab gets the repo link and four quick links; a folder name gets neither", async () => {
    const M = await load();
    const l = M.repoLinks("acme/widgets");
    const base = "https://github.com/acme/widgets";
    expect(l.url).toBe(base);
    expect(l.quick.map((q: any) => q.label)).toEqual(["Queued", "Failed", "Open PRs", "Actions"]);
    const q = (s: string) => base + "/issues?q=" + encodeURIComponent(`is:issue is:open label:"${s}"`);
    expect(l.quick[0].url).toBe(q("bunker:queued"));
    expect(l.quick[1].url).toBe(q("bunker:failed"));
    expect(l.quick[0].url).toContain("label%3A%22bunker%3Aqueued%22");
    expect(l.quick[2].url).toBe(base + "/pulls");
    expect(l.quick[3].url).toBe(base + "/actions");
    expect(M.repoLinks("my-folder")).toBeUndefined();
    expect(M.repoLinks("")).toBeUndefined();
  });

  test("refs: #N and PR #N link for an owner/repo tab and stay plain for a folder-name tab", async () => {
    const M = await load();
    expect(M.slug("dbggr/bunker")).toBe("dbggr/bunker");
    for (const bad of ["bunker", "a/b/c", "a/", "/b", "a b/c", ""]) expect(M.slug(bad)).toBe("");
    expect(M.refs("fixes #12, see PR #34", "dbggr/bunker")).toEqual([
      { text: "fixes " },
      { text: "#12", url: "https://github.com/dbggr/bunker/issues/12" },
      { text: ", see " },
      { text: "PR #34", url: "https://github.com/dbggr/bunker/pull/34" },
    ]);
    expect(M.refs("fixes #12, see PR #34", M.slug("bunker"))).toEqual([{ text: "fixes #12, see PR #34" }]);
    expect(M.refs("fixes #12", "")).toEqual([{ text: "fixes #12" }]);
  });

  test("refs: word boundaries, URLs and code-like tokens are not double-linked", async () => {
    const M = await load();
    const links = (t: string, slug = "o/r") => M.refs(t, slug).filter((s: any) => s.url).map((s: any) => s.text);
    expect(links("abc#12")).toEqual([]);
    expect(links("#12abc")).toEqual([]);
    expect(links("&#39; x#1 `a#2`")).toEqual([]);
    expect(links("see http://example.com/a#12 and #7")).toEqual(["#7"]);
    expect(links("xPR #3")).toEqual(["#3"]);
    expect(links("(#5)")).toEqual(["#5"]);
    expect(M.refs("see https://github.com/a/b/issues/9.", "o/r")).toEqual([
      { text: "see " },
      { text: "#9", url: "https://github.com/a/b/issues/9" },
      { text: "." },
    ]);
    expect(M.refs("https://github.com/a/b/pull/10", "")).toEqual([{ text: "PR #10", url: "https://github.com/a/b/pull/10" }]);
    expect(links("https://github.com/a/b/commit/1 #4")).toEqual(["#4"]);
  });

  test("waiting row status keeps the CI state", async () => {
    const M = await load();
    expect(M.waitingStatus("armed")).toBe("auto-merge armed");
    expect(M.waitingStatus("waiting: CI pending")).toBe("auto-merge armed · waiting: CI pending");
    const html = await Bun.file(new URL("../src/ui/ui.html", import.meta.url)).text();
    expect(html).toContain("Model.waitingStatus(w.ci)");
  });

  test("the page builds links as elements and never uses innerHTML", async () => {
    const html = await Bun.file(new URL("../src/ui/ui.html", import.meta.url)).text();
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(html).toContain("noreferrer");
  });

  test("page uses no external assets and spells status with icons", async () => {
    const html = await Bun.file(new URL("../src/ui/ui.html", import.meta.url)).text();
    expect(html).not.toMatch(/https?:\/\/(?!127)|@import|<link/);
    for (const s of ["✓", "✕", "●", "Nothing queued. Watching.", "read-only"]) expect(html).toContain(s);
  });

  test("audit events make an audit card, a filed list and a finished row; issue runs are unchanged", async () => {
    const M = await load();
    const r = M.newRepo();
    const a = (e: object) => M.ingest(r, ev({ audit: true, ...e }));
    a({ type: "meta", title: "Audit: tests" });
    a({ type: "stage", name: "setup" });
    a({ type: "stage", name: "audit", model: "m" });
    expect(M.tab(r, NOW).kind).toBe("working");
    let g = M.groups(r, NOW);
    expect(g.running.length).toBe(1);
    expect(g.running[0].kind).toBe("audit");
    expect(M.track(g.running[0].stage, "audit").map((s: any) => [s.name, s.state])).toEqual([["setup", "done"], ["audit", "current"], ["filing", "todo"]]);
    a({ type: "stage", name: "filing" });
    a({ type: "filed", filed: { number: 7, title: "T", url: "https://x/issues/7" } });
    a({ type: "meta", costUsd: 0.5 });
    expect(M.groups(r, NOW).running[0].filed).toEqual([{ number: 7, title: "T", url: "https://x/issues/7" }]);
    a({ type: "stage", name: "done" });
    g = M.groups(r, NOW);
    expect(g.running).toEqual([]);
    expect(g.finished.length).toBe(1);
    expect(g.finished[0]).toMatchObject({ kind: "audit", title: "Audit: tests", outcome: "audit · 1 issue filed", cost: 0.5 });
    M.ingest(r, ev({ type: "stage", issue: 9, name: "implement" }));
    expect(M.groups(r, NOW).running[0].kind).toBe("issue");
    expect(M.track("implement").length).toBe(6);
  });

  test("a failed audit is finished as failed", async () => {
    const M = await load();
    const r = M.newRepo();
    M.ingest(r, ev({ audit: true, type: "stage", name: "failed", reason: "boom" }));
    expect(M.groups(r, NOW).finished[0]).toMatchObject({ kind: "audit", outcome: "failed", reason: "boom" });
  });
});

describe("hub keeps only the latest watcher snapshot", () => {
  test("late pages get one watcher event", async () => {
    hub = startHub({ port: 0, token: TOKEN });
    for (let i = 1; i <= 3; i++) await publish(hub.url, { repo: "a/one", event: { type: "watcher", watcher: { version: String(i) }, at: i } }, TOKEN);
    const late = await connect(hub.viewUrl);
    await until(() => late.messages.length === 1);
    await Bun.sleep(50);
    expect(late.messages.map((m) => m.event.watcher.version)).toEqual(["3"]);
    late.ws.close();
  });
});

describe("ensureHub()", () => {
  test("simultaneous starts on one port: one owns the hub, the others join it", async () => {
    const probe = startHub({ port: 0, token: TOKEN });
    const port = probe.server.port!;
    await probe.stop();
    const hubs = await Promise.all([ensureHub({ port, token: TOKEN }), ensureHub({ port, token: TOKEN }), ensureHub({ port, token: TOKEN })]);
    const owned = hubs.filter((h): h is Hub => !!h);
    try {
      expect(owned.length).toBe(1);
      expect(await hubReachable(port, TOKEN)).toBe(true);
    } finally {
      await Promise.all(owned.map((h) => h.stop()));
    }
  });

  test("still throws when the port is held by something that is not our hub", async () => {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no") });
    try {
      await expect(ensureHub({ port: other.port!, token: TOKEN }, { retries: 1, delayMs: 10 })).rejects.toThrow();
    } finally {
      await other.stop(true);
    }
  });
});
