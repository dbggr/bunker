/**
 * Deny-by-default egress for agent containers (#550). A forward proxy on the agent network's gateway (the only
 * thing the container's HTTP(S)_PROXY points at) tunnels CONNECT and refuses every host that is not on the allowlist.
 * With the host firewall rules from `bunker doctor`, the bridge has no other way out.
 */
import { lookup } from "node:dns/promises";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import { PROXY_PORTS } from "./firewall.ts";

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

/** True for loopback, private, link-local, CGNAT, unspecified and ULA addresses (v4, v6 and v4-mapped v6). */
export function privateAddress(ip: string): boolean {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const a = m ? m[1]! : ip.toLowerCase();
  if (isIP(a) === 4) {
    const [x = 0, y = 0] = a.split(".").map(Number);
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
  }
  return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

/** The first free port in bunker's proxy range on `hostname`, so the firewall can name the range. */
export async function pickProxyPort(hostname: string): Promise<number> {
  for (let port = PROXY_PORTS.from; port <= PROXY_PORTS.to; port++) {
    const ok = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(port, hostname, () => s.close(() => res(true)));
    });
    if (ok) return port;
  }
  throw new Error(`no free port in ${PROXY_PORTS.from}-${PROXY_PORTS.to} for a bunker proxy`);
}

export interface EgressProxy {
  port: number;
  stop(): void;
}

export interface EgressProxyOptions {
  hostname: string;
  allow: string[];
  port?: number;
  /** Ports a tunnel may target. Defaults to 443. */
  ports?: number[];
  /** Tunnel to hosts that resolve to private/loopback/link-local addresses (tests only). */
  allowPrivate?: boolean;
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
      if (!(opts.ports ?? [443]).includes(port) || !egressAllowed(host, opts.allow)) {
        return refuse(client, "403 Forbidden", `bunker egress proxy: ${target} is not on the egress allowlist`);
      }
      client.pause();
      void tunnel(host, port, rest);
    };
    // Resolve once, refuse private addresses, then connect to that address: a wildcard entry cannot reach the LAN, and a rebinding answer cannot change it.
    const tunnel = async (host: string, port: number, rest: Buffer) => {
      let addr = host;
      try {
        const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
        if (!addrs.length || (!opts.allowPrivate && addrs.some((a) => privateAddress(a.address)))) {
          return refuse(client, "403 Forbidden", `bunker egress proxy: ${host} resolves to a private address`);
        }
        addr = addrs[0]!.address;
      } catch {
        return refuse(client, "502 Bad Gateway", "bunker egress proxy: could not resolve host");
      }
      const up = connect(port, addr);
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
