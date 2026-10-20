import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcp, escapePath, unescapePath, UNIT_TEMPLATE, type McpDeps } from "../src/mcp/server.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const repo = "/home/me/my-repo";
function setup(over: Partial<McpDeps> = {}) {
  const calls: string[][] = [];
  const labels: [string, number][] = [];
  const writes: Record<string, string> = {};
  const deps: McpDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      if (cmd[1] === "--user" && cmd[2] === "list-units") return { code: 0, stdout: `bunker-watch@${escapePath(repo)}.service loaded active running bunker watch\n`, stderr: "" };
      if (cmd[0] === "journalctl") return { code: 0, stdout: "line1\nline2\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    unitDir: "/units",
    unitExists: () => false,
    writeUnit: (p, t) => void (writes[p] = t),
    bunkerCommand: () => ["/usr/bin/bunker"],
    readCurrent: () => [{ issue: 7, stage: "verify", since: 1 }],
    hubReachable: async () => true,
    caps: async () => ({ day: 10, month: 100 }),
    spent: () => ({ day: 2.5, month: 20 }),
    addLabel: async (r, n) => void labels.push([r, n]),
    ...over,
  };
  const mcp = createMcp(deps);
  const call = async (name: string, args: object = {}) => {
    const res = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
    return { text: res.result.content[0].text as string, isError: !!res.result.isError };
  };
  return { calls, labels, writes, call, mcp };
}

describe("mcp protocol", () => {
  test("initialize, tools/list, ping, unknown method, notification", async () => {
    const { mcp } = setup();
    const init = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as any;
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.serverInfo.name).toBe("bunker");
    const list = (await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(["list_watches", "queue_issue", "restart_watch", "spend", "start_watch", "stop_watch", "watch_logs"]);
    expect(((await mcp.handle({ jsonrpc: "2.0", id: 3, method: "ping" })) as any).result).toEqual({});
    expect(((await mcp.handle({ jsonrpc: "2.0", id: 4, method: "nope" })) as any).error.code).toBe(-32601);
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });
  test("path escaping round-trips", () => {
    for (const p of ["/home/me/my-repo", "/a/b_c/d.e", "/x y/z"]) expect(unescapePath(escapePath(p))).toBe(p);
  });
});

describe("mcp tools", () => {
  test("list_watches: unit state, repo, current run, hub", async () => {
    const { call } = setup();
    const out = JSON.parse((await call("list_watches")).text);
    expect(out.hub).toBe(true);
    expect(out.watches).toEqual([{ unit: `bunker-watch@${escapePath(repo)}.service`, repo, active: "active", sub: "running", current: [{ issue: 7, stage: "verify", since: 1 }] }]);
  });
  test("start_watch installs the template when missing, then starts", async () => {
    const { call, calls, writes } = setup();
    const r = await call("start_watch", { repo });
    expect(r.isError).toBe(false);
    expect(Object.keys(writes)).toEqual(["/units/bunker-watch@.service"]);
    expect(writes["/units/bunker-watch@.service"]).toBe(UNIT_TEMPLATE(["/usr/bin/bunker"], process.env.PATH));
    expect(UNIT_TEMPLATE(["/usr/bin/bunker"])).toContain("Restart=on-failure");
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["systemctl --user daemon-reload", "systemctl --user start"]);
    expect(calls[1]).toContain(`bunker-watch@${escapePath(repo)}.service`);
  });

  test("the unit quotes ExecStart and sets PATH and token passthrough", () => {
    const unit = UNIT_TEMPLATE(["/opt/my dir/bun", "/src/cli.ts"], "/home/u/.local/bin:/usr/bin");
    expect(unit).toContain('ExecStart="/opt/my dir/bun" "/src/cli.ts" watch');
    expect(unit).toContain('Environment="PATH=/home/u/.local/bin:/usr/bin"');
    expect(unit).toContain("PassEnvironment=GH_TOKEN GITHUB_TOKEN ANTHROPIC_API_KEY");
    expect(UNIT_TEMPLATE(["/a%b/$x"], "/bin")).toContain('ExecStart="/a%%b/$$x" watch');
  });
  test("start_watch leaves an existing template alone", async () => {
    const { call, writes, calls } = setup({ unitExists: () => true });
    await call("start_watch", { repo });
    expect(writes).toEqual({});
    expect(calls.length).toBe(1);
  });
  test("stop_watch and restart_watch", async () => {
    const { call, calls } = setup();
    await call("stop_watch", { repo });
    await call("restart_watch", { repo });
    expect(calls.map((c) => c[2])).toEqual(["stop", "restart"]);
  });
  test("a failing systemctl is an error result", async () => {
    const { call } = setup({ run: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
    const r = await call("stop_watch", { repo });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("boom");
  });
  test("watch_logs asks journalctl for the last N lines", async () => {
    const { call, calls } = setup();
    const r = await call("watch_logs", { repo, lines: 50 });
    expect(r.text).toBe("line1\nline2\n");
    expect(calls[0]).toEqual(["journalctl", "--user", "-u", `bunker-watch@${escapePath(repo)}.service`, "-n", "50", "--no-pager"]);
  });
  test("spend reports today and month against the caps", async () => {
    const { call } = setup();
    expect(JSON.parse((await call("spend", { repo })).text)).toEqual({ day: { spent: 2.5, cap: 10 }, month: { spent: 20, cap: 100 } });
  });
  test("queue_issue labels the issue under the cap", async () => {
    const { call, labels } = setup();
    expect((await call("queue_issue", { repo, issue: 5 })).isError).toBe(false);
    expect(labels).toEqual([[repo, 5]]);
  });
  test("queue_issue is refused at or over the daily cap", async () => {
    for (const day of [10, 11]) {
      const { call, labels } = setup({ spent: () => ({ day, month: 0 }) });
      const r = await call("queue_issue", { repo, issue: 5 });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("cap");
      expect(labels).toEqual([]);
    }
  });
  test("queue_issue without a cap is allowed; bad input is rejected", async () => {
    const { call, labels } = setup({ caps: async () => ({}), spent: () => ({ day: 999, month: 999 }) });
    expect((await call("queue_issue", { repo, issue: 5 })).isError).toBe(false);
    expect((await call("queue_issue", { repo, issue: "x" })).isError).toBe(true);
    expect((await call("start_watch", { repo: "relative/path" })).isError).toBe(true);
    expect(labels.length).toBe(1);
  });
  test("unknown tool is an error result", async () => {
    expect((await setup().call("start_run")).isError).toBe(true);
  });
  test("no tool talks to the hub beyond a reachability check", () => {
    const src = readFileSync(join(import.meta.dir, "../src/mcp/server.ts"), "utf8");
    expect(src).not.toContain("/publish");
  });
});
