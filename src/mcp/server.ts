import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { loadRepoConfig } from "../core/config.ts";
import { capsFrom } from "../core/settings.ts";
import { DAY_MS, MONTH_MS, loadSpendCaps, spentWithin, type SpendCaps } from "../core/spend.ts";
import { liveGhEnv } from "../github/identity.ts";
import { ensureLabel, QUEUED_LABEL } from "../github/labels.ts";
import { defaultHubPort, hubReachable, readToken } from "../ui/ui.ts";
import { STATUS_FILE, type CurrentRun } from "../cli/commands/status.ts";

const PREFIX = "bunker-watch@";

/** systemd's path escaping (`systemd-escape --path`): `/` becomes `-`, anything but [A-Za-z0-9:_.] becomes `\xNN`. */
export function escapePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "").replace(/^\/+/, "");
  const esc = [...Buffer.from(trimmed)].map((b, i) => {
    const c = String.fromCharCode(b);
    if (c === "/") return "-";
    if (/[A-Za-z0-9:_]/.test(c) || (c === "." && i > 0)) return c;
    return "\\x" + b.toString(16).padStart(2, "0");
  });
  return esc.join("") || "-";
}

export function unescapePath(s: string): string {
  if (s === "-") return "/";
  const bytes = Buffer.from(s.replace(/-/g, "/").replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  return "/" + bytes.toString("utf8");
}

const unitName = (repo: string) => `${PREFIX}${escapePath(repo)}.service`;

/** The systemd user template: one instance per repo, the instance name being the escaped repo path (`%f` is the path back). */
export const UNIT_TEMPLATE = (bunker: string[]) => `[Unit]
Description=bunker watch for %f
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%f
ExecStart=${bunker.join(" ")} watch
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export interface McpDeps {
  run: (cmd: string[]) => Promise<Run>;
  unitDir: string;
  unitExists: (path: string) => boolean;
  writeUnit: (path: string, text: string) => void;
  /** argv prefix that starts bunker, e.g. ["/usr/bin/bunker"]. */
  bunkerCommand: () => string[];
  readCurrent: (repo: string) => CurrentRun[];
  hubReachable: () => Promise<boolean>;
  caps: (repo: string) => Promise<SpendCaps>;
  spent: (repo: string) => { day: number; month: number };
  addLabel: (repo: string, issue: number) => Promise<void>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  call: (args: Record<string, unknown>) => Promise<string>;
}

class ToolError extends Error {}

const repoProp = { type: "string", description: "Absolute path of the repository checkout" };
const schema = (props: Record<string, object>, required: string[]) => ({ type: "object", properties: props, required });

export function createMcp(d: McpDeps) {
  const repoArg = (a: Record<string, unknown>) => {
    const r = a.repo;
    if (typeof r !== "string" || !isAbsolute(r)) throw new ToolError("repo must be an absolute path");
    return r.replace(/(.)\/+$/, "$1");
  };
  const systemctl = async (verb: string, repo: string) => {
    const r = await d.run(["systemctl", "--user", verb, unitName(repo)]);
    if (r.code !== 0) throw new ToolError(`systemctl ${verb} failed: ${(r.stderr || r.stdout).trim()}`);
    return `${verb}: ${unitName(repo)}`;
  };

  const tools: Tool[] = [
    {
      name: "list_watches",
      description: "List the local bunker watches (systemd user units): unit state, repo and the run in flight",
      inputSchema: schema({}, []),
      async call() {
        const r = await d.run(["systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", `${PREFIX}*.service`]);
        if (r.code !== 0) throw new ToolError(`systemctl list-units failed: ${(r.stderr || r.stdout).trim()}`);
        const watches = r.stdout.split("\n").flatMap((line) => {
          const m = line.trim().match(/^(bunker-watch@(\S+)\.service)\s+(\S+)\s+(\S+)\s+(\S+)/);
          if (!m) return [];
          const repo = unescapePath(m[2]!);
          return [{ unit: m[1]!, repo, active: m[4]!, sub: m[5]!, current: d.readCurrent(repo) }];
        });
        return JSON.stringify({ hub: await d.hubReachable(), watches }, null, 2);
      },
    },
    {
      name: "start_watch",
      description: "Start `bunker watch` for a repo as a systemd user unit; installs the bunker-watch@.service template if missing",
      inputSchema: schema({ repo: repoProp }, ["repo"]),
      async call(a) {
        const repo = repoArg(a);
        const path = join(d.unitDir, `${PREFIX}.service`);
        if (!d.unitExists(path)) {
          d.writeUnit(path, UNIT_TEMPLATE(d.bunkerCommand()));
          const r = await d.run(["systemctl", "--user", "daemon-reload"]);
          if (r.code !== 0) throw new ToolError(`systemctl daemon-reload failed: ${(r.stderr || r.stdout).trim()}`);
        }
        return systemctl("start", repo);
      },
    },
    { name: "stop_watch", description: "Stop the bunker watch of a repo", inputSchema: schema({ repo: repoProp }, ["repo"]), call: (a) => systemctl("stop", repoArg(a)) },
    { name: "restart_watch", description: "Restart the bunker watch of a repo", inputSchema: schema({ repo: repoProp }, ["repo"]), call: (a) => systemctl("restart", repoArg(a)) },
    {
      name: "watch_logs",
      description: "The last N journal lines of a repo's bunker watch",
      inputSchema: schema({ repo: repoProp, lines: { type: "integer", description: "How many lines (default 100)" } }, ["repo"]),
      async call(a) {
        const repo = repoArg(a);
        const n = a.lines === undefined ? 100 : Number(a.lines);
        if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new ToolError("lines must be an integer from 1 to 10000");
        const r = await d.run(["journalctl", "--user", "-u", unitName(repo), "-n", String(n), "--no-pager"]);
        if (r.code !== 0) throw new ToolError(`journalctl failed: ${(r.stderr || r.stdout).trim()}`);
        return r.stdout;
      },
    },
    {
      name: "spend",
      description: "Spend today (rolling 24 h) and this month (30 days) against the caps, in notional USD",
      inputSchema: schema({ repo: repoProp }, ["repo"]),
      async call(a) {
        const repo = repoArg(a);
        const caps = await d.caps(repo);
        const s = d.spent(repo);
        return JSON.stringify({ day: { spent: s.day, cap: caps.day ?? null }, month: { spent: s.month, cap: caps.month ?? null } });
      },
    },
    {
      name: "queue_issue",
      description: `Label an issue ${QUEUED_LABEL} so the watch picks it up; refused when today's spend is at or over the daily cap`,
      inputSchema: schema({ repo: repoProp, issue: { type: "integer", description: "Issue number" } }, ["repo", "issue"]),
      async call(a) {
        const repo = repoArg(a);
        const issue = a.issue;
        if (typeof issue !== "number" || !Number.isInteger(issue) || issue < 1) throw new ToolError("issue must be a positive integer");
        const cap = (await d.caps(repo)).day;
        const spent = d.spent(repo).day;
        if (cap !== undefined && spent >= cap) throw new ToolError(`refused: spent $${spent.toFixed(2)} today, at or over the daily cap of $${cap}`);
        await d.addLabel(repo, issue);
        return `queued #${issue} (${QUEUED_LABEL})`;
      },
    },
  ];

  return {
    tools,
    /** One JSON-RPC message in, the reply out (undefined for a notification). */
    async handle(msg: any): Promise<object | undefined> {
      const id = msg?.id;
      const ok = (result: object) => ({ jsonrpc: "2.0", id, result });
      const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
      if (id === undefined || id === null) return undefined;
      switch (msg.method) {
        case "initialize":
          return ok({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "bunker", version: "1" } });
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case "tools/call": {
          const tool = tools.find((t) => t.name === msg.params?.name);
          if (!tool) return ok({ isError: true, content: [{ type: "text", text: `unknown tool: ${msg.params?.name}` }] });
          try {
            return ok({ content: [{ type: "text", text: await tool.call(msg.params?.arguments ?? {}) }] });
          } catch (e) {
            return ok({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
          }
        }
        default:
          return err(-32601, `method not found: ${msg.method}`);
      }
    },
  };
}

async function exec(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", ...opts });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

export function liveDeps(): McpDeps {
  const bunkerDir = (repo: string) => join(repo, ".bunker");
  return {
    run: exec,
    unitDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user"),
    unitExists: existsSync,
    writeUnit: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    // From source (bun src/cli.ts) the unit needs bun plus the script; an installed binary runs itself.
    bunkerCommand: () => (/(^|\/)bun$/.test(process.execPath) ? [process.execPath, join(import.meta.dir, "..", "cli.ts")] : [process.execPath]),
    readCurrent: (repo) => {
      try {
        const raw = JSON.parse(readFileSync(join(bunkerDir(repo), STATUS_FILE), "utf8"));
        return Array.isArray(raw.current) ? raw.current : [];
      } catch {
        return [];
      }
    },
    hubReachable: () => hubReachable(defaultHubPort(), readToken()),
    caps: async (repo) => {
      const cfg = (await loadRepoConfig(repo, { lenient: true })).config;
      return capsFrom(cfg.watch, await loadSpendCaps().catch(() => ({})));
    },
    spent: (repo) => {
      const file = join(bunkerDir(repo), "watch-spend.json");
      return { day: spentWithin(file, DAY_MS), month: spentWithin(file, MONTH_MS) };
    },
    addLabel: async (repo, issue) => {
      const env = liveGhEnv();
      await ensureLabel(QUEUED_LABEL, repo, env);
      const r = await exec(["gh", "issue", "edit", String(issue), "--add-label", QUEUED_LABEL], { cwd: repo, env });
      if (r.code !== 0) throw new ToolError(`gh issue edit failed: ${(r.stderr || r.stdout).trim()}`);
    },
  };
}

/** Serves MCP over stdio: one JSON-RPC message per line. */
export async function serveStdio(mcp = createMcp(liveDeps())): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const write = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      const reply = await mcp.handle(msg);
      if (reply) write(reply);
    }
  }
}
