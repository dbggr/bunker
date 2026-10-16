import type { Server } from "bun";
import { redact } from "./redact.ts";
import type { BunkerEvent, OnEvent } from "./events.ts";
import page from "./ui.html" with { type: "text" };

export interface UiServer {
  /** e.g. http://127.0.0.1:4321 */
  url: string;
  server: Server<unknown>;
  onEvent: OnEvent;
  stop: () => Promise<void>;
}

const HOST = "127.0.0.1";

/** Redacts every string field of an event. */
function clean(e: BunkerEvent): BunkerEvent {
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])) as unknown as BunkerEvent;
}

/** A read-only live view of a run. Always binds to loopback; there is no option to change that. */
export function startUi({ port = 4321 }: { port?: number } = {}): UiServer {
  const history: string[] = [];
  const server = Bun.serve({
    hostname: HOST,
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      // Refuse foreign Host/Origin so a web page can't reach us via DNS rebinding.
      const allowed = (h: string) => h === `${HOST}:${srv.port}` || h === `localhost:${srv.port}`;
      if (!allowed(req.headers.get("host") ?? "")) return new Response("forbidden", { status: 403 });
      const origin = req.headers.get("origin");
      if (origin && !allowed(origin.replace(/^https?:\/\//, ""))) return new Response("forbidden", { status: 403 });
      if (req.method !== "GET") return new Response("read-only", { status: 405 });
      if (url.pathname === "/") return new Response(page as unknown as string, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/events" && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("events");
        for (const m of history) ws.send(m);
      },
      // Read-only: anything a client sends is ignored.
      message() {},
    },
  });
  return {
    url: `http://${HOST}:${server.port}`,
    server,
    onEvent(e) {
      const msg = JSON.stringify(clean(e));
      history.push(msg);
      server.publish("events", msg);
    },
    stop: async () => void (await server.stop(true)),
  };
}
