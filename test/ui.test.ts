import { afterEach, describe, expect, test } from "bun:test";
import { startUi, type UiServer } from "../src/ui.ts";

let ui: UiServer | undefined;
afterEach(async () => {
  await ui?.stop();
  ui = undefined;
});

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

describe("startUi()", () => {
  test("starts on a free port, loopback only, and serves the page", async () => {
    ui = startUi({ port: 0 });
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(ui.server.hostname).toBe("127.0.0.1");
    const res = await fetch(ui.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const s of ["WebSocket", "waiting for merge", "log"]) expect(html).toContain(s);
  });

  test("there is no way to bind a non-loopback address", () => {
    ui = startUi({ port: 0, hostname: "0.0.0.0" } as any);
    expect(ui.server.hostname).toBe("127.0.0.1");
  });

  test("an emitted event reaches a connected client, redacted, and late clients get history", async () => {
    ui = startUi({ port: 0 });
    const early = await connect(ui.url);
    ui.onEvent({ type: "text", issue: 7, text: "token sk-ant-secret123 here", at: 1 });
    await until(() => early.messages.length === 1);
    expect(early.messages[0].issue).toBe(7);
    expect(early.messages[0].text).toBe("token [REDACTED] here");
    const late = await connect(ui.url);
    await until(() => late.messages.length === 1);
    expect(late.messages[0].text).toBe("token [REDACTED] here");
    early.ws.close();
    late.ws.close();
  });

  test("read-only: only GET / and the event socket exist", async () => {
    ui = startUi({ port: 0 });
    for (const method of ["POST", "PUT", "DELETE"]) expect((await fetch(ui.url + "/", { method })).status).toBe(405);
    expect((await fetch(ui.url + "/nope")).status).toBe(404);
  });

  test("rejects a foreign Host header (DNS rebinding)", async () => {
    ui = startUi({ port: 0 });
    const res = await fetch(ui.url + "/", { headers: { Host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("stop() closes the server", async () => {
    ui = startUi({ port: 0 });
    const url = ui.url;
    await ui.stop();
    ui = undefined;
    expect(fetch(url + "/").then(() => "up", () => "down")).resolves.toBe("down");
  });
});
