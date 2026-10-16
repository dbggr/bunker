#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { AUTH_HINT, hasAuth, loadBunkerEnv } from "./env.ts";
import { AgentFailure, claudeCode, formatDuration, formatUsage, docker, noSandbox, review, run, runAll } from "./index.ts";
import { runAudit } from "./audit.ts";
import { runIssue, runQueue } from "./issue.ts";
import { parseDuration, runWatch } from "./watch.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.ts";
import { createProgress, type BunkerEvent, hyperlink } from "./events.ts";
import { startUi } from "./ui.ts";
import { HELP } from "./help.ts";
import { options } from "./options.ts";
import { output } from "./output.ts";
import pkg from "../package.json" with { type: "json" };

// Anything printed first wipes the in-place progress line, if one is showing.
let clearProgress = () => {};

// Everything the CLI prints goes through redact().
for (const method of ["log", "error", "warn"] as const) {
  const orig = console[method].bind(console);
  console[method] = (...args: unknown[]) => (clearProgress(), orig(...args.map((a) => (typeof a === "string" ? redact(a) : a))));
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options });
} catch (e) {
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const msg = e instanceof Error ? e.message : String(e);
  const unknown = msg.match(/Unknown option '(-[^']*)'/);
  console.error(`bunker: ${unknown ? `unknown option ${unknown[1]}` : msg.split(". ")[0]}\nsee bunker --help`);
  process.exit(2);
}
const { values, positionals } = parsed;

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

const prompt = positionals.join(" ");
const tasks = values.task ?? [];
let watchOpts: { intervalMs: number; maxCostUsd: number; forMs?: number } | undefined;
if (values.watch) {
  if (prompt || tasks.length || values.review || values.issue !== undefined || values.queue || values.audit || values.limit !== undefined) {
    console.error("bunker: --watch can't be combined with a prompt, --task, --review, --issue, --queue, --audit or --limit");
    process.exit(2);
  }
  const intervalMin = values.interval === undefined ? 10 : Number(values.interval);
  if (!(intervalMin > 0) || !Number.isFinite(intervalMin)) {
    console.error("bunker: --interval must be a positive number of minutes");
    process.exit(2);
  }
  const maxCostUsd = values["max-cost"] === undefined ? 20 : Number(values["max-cost"]);
  if (!(maxCostUsd > 0) || !Number.isFinite(maxCostUsd)) {
    console.error("bunker: --max-cost must be a positive number of US dollars");
    process.exit(2);
  }
  let forMs: number | undefined;
  if (values.for !== undefined) {
    forMs = parseDuration(values.for);
    if (forMs === undefined) {
      console.error('bunker: --for must be a duration like 5h, 90m or 2h30m');
      process.exit(2);
    }
  }
  if (!values.verify && !existsSync(join(process.cwd(), ".bunker", "verify"))) {
    console.error("bunker: --watch needs a verify command: pass --verify \"<cmd>\" or add a .bunker/verify file");
    process.exit(2);
  }
  watchOpts = { intervalMs: intervalMin * 60_000, maxCostUsd, ...(forMs === undefined ? {} : { forMs }) };
  values.queue = true;
  values.merge = true;
} else if (values.interval !== undefined || values.for !== undefined || values["max-cost"] !== undefined) {
  console.error("bunker: --interval, --for and --max-cost only apply to --watch");
  process.exit(2);
}
if (values.audit) {
  if (prompt || tasks.length || values.review || values.issue !== undefined || values.queue) {
    console.error("bunker: --audit can't be combined with a prompt, --task, --review, --issue or --queue");
    process.exit(2);
  }
  if (values.verify !== undefined || values.merge || values["verify-on-host"]) {
    console.error("bunker: --verify, --verify-on-host and --merge don't apply to --audit");
    process.exit(2);
  }
} else if (values["max-issues"] !== undefined || values.focus !== undefined) {
  console.error("bunker: --max-issues and --focus only apply to --audit");
  process.exit(2);
}
const maxIssues = values["max-issues"] === undefined ? 5 : Number(values["max-issues"]);
if (!Number.isInteger(maxIssues) || maxIssues < 1) {
  console.error("bunker: --max-issues must be a positive integer");
  process.exit(2);
}
// Whether --merge has a verify command is decided by runIssue, from origin's default branch.
if (values.audit) {
  // checked above
} else if (values.queue) {
  if (prompt || tasks.length || values.review || values.issue !== undefined) {
    console.error("bunker: --queue can't be combined with a prompt, --task, --review or --issue");
    process.exit(2);
  }
} else if (values.limit !== undefined) {
  console.error("bunker: --limit only applies to --queue");
  process.exit(2);
} else if (values.issue !== undefined) {
  if (prompt || tasks.length || values.review) {
    console.error("bunker: --issue can't be combined with a prompt, --task or --review");
    process.exit(2);
  }
}
if (!values.audit && values.issue === undefined && !values.queue && (values.verify !== undefined || values.setup !== undefined || values.merge || values["verify-on-host"])) {
  console.error("bunker: --setup, --verify, --verify-on-host and --merge only apply to --issue or --queue");
  process.exit(2);
}
if (!values.audit && values.issue === undefined && !values.queue && !prompt === !tasks.length) {
  console.error(
    'usage: bunker "<prompt>" [--model <id>] [--image <name>] [--no-sandbox] [--max-iterations <n>]\n' +
      '       bunker --review "<prompt>" [--max-rounds <n>] [--reviewer-model <id>]   (implement → review → fix)\n' +
      '       bunker --issue <n> [--setup "<cmd>"] [--verify "<cmd>" [--verify-on-host] [--merge [--ci-timeout <min>]]] [--max-rounds <n>] [--reviewer-model <id>]   (issue → reviewed PR)\n' +
      '       bunker --queue [--setup "<cmd>"] [--verify "<cmd>" [--verify-on-host] [--merge [--ci-timeout <min>]]] [--limit <n>]   (work the `bunker` label queue)\n' +
      '       bunker --watch [--interval <min>] [--for <duration>] [--max-cost <usd>] [--verify "<cmd>"]   (work the queue unattended, auto-merging)\n' +
      '       bunker --audit [--max-issues <n>] [--focus "<text>"] [--setup "<cmd>"]   (file improvement ideas as `discovered` issues)\n' +
      '       bunker --task "<prompt>" --task "<prompt>" ...   (parallel, one worktree each)\n' +
      "run bunker --help for all options",
  );
  process.exit(2);
}

if (!values.ui && (values.port !== undefined || values["ui-keep"])) {
  console.error("bunker: --port and --ui-keep only apply to --ui");
  process.exit(2);
}
if (values.ui && values.issue === undefined && !values.queue) {
  console.error("bunker: --ui only applies to --issue or --queue");
  process.exit(2);
}
const uiPort = values.port === undefined ? 4321 : Number(values.port);
if (!Number.isInteger(uiPort) || uiPort < 0 || uiPort > 65535) {
  console.error("bunker: --port must be an integer between 0 and 65535");
  process.exit(2);
}

const maxIterations = values["max-iterations"] === undefined ? 1 : Number(values["max-iterations"]);
if (!Number.isInteger(maxIterations) || maxIterations < 1) {
  console.error("bunker: --max-iterations must be a positive integer");
  process.exit(2);
}

const maxRounds = values["max-rounds"] === undefined ? 2 : Number(values["max-rounds"]);
if (!Number.isInteger(maxRounds) || maxRounds < 1) {
  console.error("bunker: --max-rounds must be a positive integer");
  process.exit(2);
}
if (values.review && !prompt) {
  console.error("bunker: --review takes a single prompt, not --task");
  process.exit(2);
}

const limit = values.limit === undefined ? 5 : Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) {
  console.error("bunker: --limit must be a positive integer");
  process.exit(2);
}

await loadBunkerEnv(process.cwd());
if (!values["no-sandbox"] && !hasAuth()) {
  // On the host claude can use your login; in a container it only has what we pass in.
  console.error(AUTH_HINT);
  process.exit(2);
}

let ciTimeoutMin: number | undefined;
if (values["ci-timeout"] !== undefined) {
  ciTimeoutMin = Number(values["ci-timeout"]);
  if (!(ciTimeoutMin > 0) || !values.merge) {
    console.error("bunker: --ci-timeout must be a positive number of minutes and requires --merge");
    process.exit(2);
  }
}

if (values.verbose) output.verbose = true;
// The in-place progress line must not outlive the run.
process.on("exit", () => clearProgress());
const startedAt = Date.now();
process.on("exit", () => console.log(`bunker: elapsed ${formatDuration(Date.now() - startedAt)} (wall-clock)`));

const tty = !!process.stdout.isTTY;
const progress = createProgress({ write: (s) => output.write(redact(s)), tty, columns: process.stdout.columns ?? 100 });
let ui;
if (values.ui) {
  try {
    ui = startUi({ port: uiPort });
  } catch (e) {
    console.error(`bunker: could not start --ui: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log(`bunker: live view at ${ui.url}`);
}
const onEvent = ui ? (e: BunkerEvent) => (progress.onEvent(e), ui.onEvent(e)) : progress.onEvent;
clearProgress = progress.clear;
const agent = claudeCode({ model: values.model, json: true });
const sandbox = values["no-sandbox"] ? noSandbox() : docker({ image: values.image });

if (values.audit) {
  let result;
  try {
    result = await runAudit({ agent, sandbox, maxIssues, focus: values.focus, setup: values.setup });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log();
  for (const t of result.skipped) console.log(`bunker: skipped (already open): ${t}`);
  if (!result.filed.length) console.log("bunker: no issues filed");
  for (const f of result.filed) console.log(`filed #${f.number}: ${f.title}`);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
} else if (watchOpts) {
  const reviewer = values["reviewer-model"] ? claudeCode({ model: values["reviewer-model"], json: true }) : agent;
  const ctl = new AbortController();
  // The first signal finishes the current step and exits 0; a second one quits now.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (ctl.signal.aborted) process.exit(130);
      console.log(`bunker: ${sig} received; finishing the current step, then exiting (again to quit now)`);
      ctl.abort();
    });
  }
  try {
    await runWatch({ onEvent, agent, reviewer, sandbox, maxRounds, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], ciTimeoutMin, signal: ctl.signal, ...watchOpts });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
} else if (values.queue) {
  const reviewer = values["reviewer-model"] ? claudeCode({ model: values["reviewer-model"], json: true }) : agent;
  let results;
  try {
    results = await runQueue({ onEvent, agent, reviewer, sandbox, maxRounds, limit, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], merge: values.merge, ciTimeoutMin });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log();
  if (!results.length) console.log("bunker: queue is empty");
  for (const r of results) {
    console.log(`#${r.issue} [${r.status}] ${r.prUrl ?? "-"}`);
    if (r.error) console.log(`  ${r.error.trimEnd().replaceAll("\n", "\n  ")}`);
    if (r.logPath) console.log(`  log: ${tty ? hyperlink(r.logPath) : r.logPath}`);
    if (r.review?.usage) console.log(`  cost ${formatUsage(r.review.usage)}`);
    for (const f of r.filed) console.log(`  filed #${f.number}: ${f.title}`);
  }
  if (results.some((r) => r.status !== (values.merge ? "merged" : "pr-opened"))) process.exitCode = 1;
} else if (values.issue !== undefined) {
  const issue = Number(values.issue);
  if (!Number.isInteger(issue) || issue < 1) {
    console.error("bunker: --issue must be a positive integer");
    process.exit(2);
  }
  const reviewer = values["reviewer-model"] ? claudeCode({ model: values["reviewer-model"], json: true }) : agent;
  let result;
  try {
    result = await runIssue({ onEvent, issue, agent, reviewer, sandbox, maxRounds, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], merge: values.merge, ciTimeoutMin });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log();
  for (const [i, r] of (result.review?.rounds ?? []).entries()) {
    console.log(`bunker: round ${i + 1}: ${r.commits.length} commit(s), ${r.approved ? "approved" : "changes requested"}`);
  }
  console.log(`bunker: [${result.status}] ${result.branch} (worktree ${result.worktree})`);
  if (result.error) console.log(`  ${result.error.trimEnd().replaceAll("\n", "\n  ")}`);
  if (result.prUrl) console.log(result.prUrl);
  if (result.review?.usage) console.log(`bunker: cost ${formatUsage(result.review.usage)}`);
  if (result.logPath) console.log(`bunker: log ${tty ? hyperlink(result.logPath) : result.logPath}`);
  if (result.status !== (values.merge ? "merged" : "pr-opened")) process.exitCode = 1;
} else if (values.review) {
  const reviewer = values["reviewer-model"] ? claudeCode({ model: values["reviewer-model"], json: true }) : agent;
  const result = await review({ onEvent, prompt, agent, reviewer, sandbox, maxRounds });
  console.log();
  for (const [i, r] of result.rounds.entries()) {
    console.log(`bunker: round ${i + 1}: ${r.commits.length} commit(s), ${r.approved ? "approved" : "changes requested"}`);
  }
  console.log(`bunker: [${result.status}] ${result.branch} (${result.commits.length} commit(s))`);
  for (const c of result.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
  if (result.error) console.log(`  ${result.error.trimEnd().replaceAll("\n", "\n  ")}`);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
  if (result.status !== "approved") process.exit(1);
} else if (prompt) {
  let result;
  try {
    result = await run({ onEvent, prompt, agent, sandbox, maxIterations });
  } catch (e) {
    console.error(`\nbunker: ${e instanceof Error ? e.message : e}`);
    if (e instanceof AgentFailure && e.usage) console.log(`bunker: cost ${formatUsage(e.usage)}`);
    process.exit(1);
  }
  console.log(`\nbunker: ${result.commits.length} commit(s) merged from ${result.branch}`);
  for (const c of result.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
} else {
  const results = await runAll({ onEvent, tasks: tasks.map((p) => ({ prompt: p })), agent, sandbox, maxIterations });
  console.log();
  for (const r of results) {
    console.log(`bunker: [${r.status}] ${r.branch} (${r.commits.length} commit(s)) ${r.prompt}`);
    for (const c of r.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
    if (r.usage) console.log(`  cost ${formatUsage(r.usage)}`);
    if (r.error) console.log(`  ${r.error.trimEnd().replaceAll("\n", "\n  ")}`);
  }
  if (results.some((r) => r.status !== "merged")) process.exit(1);
}

if (ui) {
  if (values["ui-keep"]) {
    console.log(`bunker: run finished; still serving ${ui.url} (Ctrl-C to quit)`);
    await new Promise(() => {});
  }
  await ui.stop();
}
