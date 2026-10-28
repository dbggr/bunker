/**
 * Deny-by-default egress for agent containers (#550). A forward proxy on the agent network's gateway (the only
 * thing the container's HTTP(S)_PROXY points at) tunnels CONNECT and refuses every host that is not on the allowlist.
 * With the host firewall rules from `bunker doctor`, the bridge has no other way out.
 */
import { createServer, connect, type Server, type Socket } from "node:net";

/** What a run needs: Claude, GitHub (git, gh, tarballs), npm and Bun's install hosts. */
export const DEFAULT_EGRESS = [
  "api.anthropic.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "registry.npmjs.org",
  "bun.sh",
];

/** The defaults plus a repo's `[sandbox] egress`, without duplicates. */
export const effectiveEgress = (extra: string[] = []): string[] => [...new Set([...DEFAULT_EGRESS, ...extra.map((h) => h.trim().toLowerCase()).filter(Boolean)])];

/** Exact host match, or `*.example.com` for subdomains of example.com (not the apex). */
export function egressAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

export interface EgressProxy {
  port: number;
  stop(): void;
}

export interface EgressProxyOptions {
  hostname: string;
  allow: string[];
  port?: number;
}

const refuse = (s: Socket, status: string, why: string) => s.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${why.length}\r\n\r\n${why}`);

export function startEgressProxy(opts: EgressProxyOptions): EgressProxy {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 16384) refuse(client, "431 Request Header Fields Too Large", "bunker egress proxy: header too large");
        return;
      }
      client.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      const [method = "", target = ""] = head.split("\r\n")[0]!.split(" ");
      if (method.toUpperCase() !== "CONNECT") {
        // Plain HTTP is never forwarded: it would leak the request in the clear, and the tools use CONNECT for https.
        let host = "";
        try {
          host = new URL(target).hostname;
        } catch {}
        return refuse(client, "403 Forbidden", `bunker egress proxy: ${host || "request"} refused (only allowlisted https hosts)`);
      }
      const i = target.lastIndexOf(":");
      const host = i > 0 ? target.slice(0, i).replace(/^\[|\]$/g, "") : target;
      const port = i > 0 ? Number(target.slice(i + 1)) : 443;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !egressAllowed(host, opts.allow)) {
        return refuse(client, "403 Forbidden", `bunker egress proxy: ${target} is not on the egress allowlist`);
      }
      const up = connect(port, host);
      sockets.add(up);
      up.on("close", () => sockets.delete(up));
      up.on("error", () => {
        if (client.writable) refuse(client, "502 Bad Gateway", "bunker egress proxy: upstream unreachable");
        client.destroy();
      });
      client.on("close", () => up.destroy());
      up.on("close", () => client.destroy());
      up.on("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) up.write(rest);
        client.pipe(up);
        up.pipe(client);
      });
    };
    client.on("data", onData);
  });
  server.listen(opts.port ?? 0, opts.hostname);
  server.unref();
  return {
    get port() {
      return (server.address() as { port: number }).port;
    },
    stop() {
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}
