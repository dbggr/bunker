import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { createServer, connect } from "node:net";
import { DEFAULT_EGRESS, egressAllowed, effectiveEgress, privateAddress, startEgressProxy } from "../src/sandboxes/egress.ts";
import { parseConfig } from "../src/core/config.ts";
import { firewallRules, egressDenied, proxyReachable, rulesBlock, PROXY_PORTS, bridgeName } from "../src/sandboxes/firewall.ts";

setDefaultTimeout(60_000); // see test/setup.ts

describe("egress allowlist", () => {
  test("defaults cover Anthropic, GitHub, npm and Bun", () => {
    for (const h of ["api.anthropic.com", "github.com", "api.github.com", "codeload.github.com", "registry.npmjs.org", "bun.sh"]) {
      expect(egressAllowed(h, DEFAULT_EGRESS)).toBe(true);
    }
    expect(egressAllowed("evil.example", DEFAULT_EGRESS)).toBe(false);
  });
  test("exact match is case-insensitive and does not match suffixes; *. matches subdomains only", () => {
    expect(egressAllowed("GitHub.com", ["github.com"])).toBe(true);
    expect(egressAllowed("evilgithub.com", ["github.com"])).toBe(false);
    expect(egressAllowed("github.com.evil.io", ["github.com"])).toBe(false);
    expect(egressAllowed("a.pkg.dev", ["*.pkg.dev"])).toBe(true);
    expect(egressAllowed("pkg.dev", ["*.pkg.dev"])).toBe(false);
  });
  test("effectiveEgress extends the defaults, deduplicated", () => {
    const e = effectiveEgress(["pypi.org", "github.com"]);
    expect(e).toContain("pypi.org");
    expect(e.filter((h) => h === "github.com")).toHaveLength(1);
  });
  test("config sandbox.egress parses and is validated", () => {
    expect(parseConfig('[sandbox]\negress = ["pypi.org"]').config.sandbox.egress).toEqual(["pypi.org"]);
    expect(() => parseConfig("[sandbox]\negress = 3")).toThrow();
  });
  test("firewall rules reject all other bridge traffic; egressDenied checks for it", () => {
    const net = { bridge: bridgeName("0123456789abcdef"), subnet: "172.20.0.0/16", gateway: "172.20.0.1" };
    const rules = firewallRules(net);
    expect(rules.some((r) => r === `iptables -I DOCKER-USER -i ${net.bridge} -j REJECT`)).toBe(true);
    expect(egressDenied(net, `-A DOCKER-USER -i ${net.bridge} -j REJECT`)).toBe(true);
    expect(egressDenied(net, `-A DOCKER-USER -i ${net.bridge} -d 10.0.0.0/8 -j REJECT`)).toBe(false);
    // the INPUT carve-out keeps the proxies on the gateway reachable
    expect(rules.some((r) => r.includes(`-I INPUT -i ${net.bridge} -d ${net.gateway} -p tcp --dport ${PROXY_PORTS.from}:${PROXY_PORTS.to} -j ACCEPT`))).toBe(true);
    const applied = rules.filter((r) => r.includes(" INPUT ")).reduce<string[]>((st, r) => [r.replace("iptables -I INPUT", "-A INPUT"), ...st], []).join("\n");
    expect(proxyReachable(net, applied)).toBe(true);
    expect(rulesBlock(net, `-A DOCKER-USER -d 10.0.0.0/8 -i ${net.bridge} -j REJECT\n-A DOCKER-USER -d 172.16.0.0/12 -i ${net.bridge} -j REJECT\n-A DOCKER-USER -d 192.168.0.0/16 -i ${net.bridge} -j REJECT`, applied)).toBe(true);
    expect(proxyReachable(net, `-A INPUT -i ${net.bridge} -m conntrack --ctstate NEW -j REJECT`)).toBe(false);
    // an ACCEPT below the REJECT never matches
    expect(proxyReachable(net, `-A INPUT -i ${net.bridge} -m conntrack --ctstate NEW -j REJECT\n-A INPUT -i ${net.bridge} -d ${net.gateway} -p tcp -m tcp --dport ${PROXY_PORTS.from}:${PROXY_PORTS.to} -j ACCEPT`)).toBe(false);
  });
});

describe("egress proxy", () => {
  const upstream = createServer((s) => s.on("data", (d) => s.write(d)));
  const ports: number[] = [];
  upstream.listen(0, "127.0.0.1", () => ports.push((upstream.address() as { port: number }).port));
  const proxy = startEgressProxy({ hostname: "127.0.0.1", allow: ["127.0.0.1"], allowPrivate: true, ports });
  // same allowlist entries, but private addresses are refused (the default)
  const strict = startEgressProxy({ hostname: "127.0.0.1", allow: ["127.0.0.1", "localhost"], ports });
  afterAll(() => {
    upstream.close();
    proxy.stop();
    strict.stop();
  });

  const request = (target: string, payload?: string, via = proxy) =>
    new Promise<string>((resolve) => {
      let out = "";
      const s = connect(via.port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      s.on("data", (d) => {
        out += d;
        if (payload && out.includes("200") && !out.includes("echo:")) s.write(`echo:${payload}`);
        if (!payload || out.includes("echo:")) s.end();
      });
      s.on("close", () => resolve(out));
    });

  test("an allowed host is reachable", async () => {
    const out = await request(`127.0.0.1:${(upstream.address() as { port: number }).port}`, "hi");
    expect(out).toContain("200");
    expect(out).toContain("echo:hi");
  });
  test("a non-allowed host is refused", async () => {
    const out = await request(`localhost:${(upstream.address() as { port: number }).port}`);
    expect(out).toContain("403");
  });
  test("an allowlisted host that resolves to a private address is refused", async () => {
    expect(await request(`localhost:${ports[0]}`, undefined, strict)).toContain("403");
    expect(await request(`127.0.0.1:${ports[0]}`, undefined, strict)).toContain("403");
  });
  test("a port outside the allowed ones is refused", async () => {
    expect(await request("127.0.0.1:22")).toContain("403");
  });
  test("privateAddress", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(privateAddress(a)).toBe(true);
    for (const a of ["140.82.112.3", "172.32.0.1", "2606:4700::1"]) expect(privateAddress(a)).toBe(false);
  });
  test("plain http to a non-allowed host is refused", async () => {
    const out = await new Promise<string>((resolve) => {
      let o = "";
      const s = connect(proxy.port, "127.0.0.1", () => s.write("GET http://example.org/ HTTP/1.1\r\nHost: example.org\r\n\r\n"));
      s.on("data", (d) => (o += d));
      s.on("close", () => resolve(o));
    });
    expect(out).toContain("403");
  });
});

test("agent containers get proxy env pointing at the gateway; an extra repo host is allowed", async () => {
  const { mkdtemp, writeFile, chmod, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { docker } = await import("../src/sandboxes/container.ts");
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakedocker-"));
  const net = JSON.stringify([{ IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }]);
  await writeFile(join(dir, "docker"), `#!/bin/sh\nif [ "$1" = network ] && [ "$2" = inspect ]; then echo '${net}'; exit 0; fi\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\n`);
  await chmod(join(dir, "docker"), 0o755);
  delete process.env.BUNKER_EGRESS_PROXY;
  try {
    await docker({ image: "img", bin: join(dir, "docker"), egress: ["pypi.org"] }).exec(["agent"], { worktree: dir, gitCommonDir: join(dir, ".git") });
    const args = await readFile(join(dir, "args"), "utf8");
    expect(args).toMatch(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/);
    expect(args).toContain("NO_PROXY=127.0.0.1,localhost,127.0.0.1");
    // isolated verify gets no proxy: it has no network at all
    await docker({ image: "img", bin: join(dir, "docker") }).exec(["agent"], { worktree: dir, gitCommonDir: join(dir, ".git"), isolate: true });
    expect(await readFile(join(dir, "args"), "utf8")).not.toContain("PROXY");
  } finally {
    process.env.BUNKER_EGRESS_PROXY = "off";
  }
});
