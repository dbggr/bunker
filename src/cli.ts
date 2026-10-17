#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { AUTH_HINT, hasAuth, loadBunkerEnv } from "./env.ts";
import { $ } from "bun";
import { AgentFailure, UsageLimit, claudeCode, formatDuration, formatUsage, docker, noSandbox, review, run, runAll, worktreeAdmin } from "./index.ts";
import { loadRepoConfigOrExit } from "./config.ts";
import { resolveModels } from "./models.ts";
import { formatChecks, runDoctor } from "./doctor.ts";
import { runInit, terminalIo } from "./init.ts";
import { runAudit } from "./audit.ts";
import { runIssue, runQueue } from "./issue.ts";
import { loadSpendCaps } from "./spend.ts";
import { configAllowedLabelers, enforceLabeler } from "./labeler.ts";
import { parseDuration, runWatch } from "./watch.ts";
import { desktopNotifier, resolveMention } from "./notify.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.ts";
import { createProgress, emit, type BunkerEvent, hyperlink } from "./events.ts";
import { connectHub, hubReachable, readToken, repoId, startHub, type Hub, type Publisher } from "./ui.ts";
import { HELP } from "./help.ts";
import { options } from "./options.ts";
import { output } from "./output.ts";
import { safePull } from "./pull.ts";
import { runClean } from "./clean.ts";
import { selfUpdate } from "./self-update.ts";
import { buildLabel } from "./build-info.ts";
import pkg from "../package.json" with { type: "json" };

/** When to re-run after a usage-limit pause (exit code 3). */
function rerunHint(resetAt?: number): string {
  return resetAt !== undefined ? `re-run after ${new Date(resetAt).toISOString()} to resume` : "re-run later to resume (no reset time was given)";
}

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
  console.log(`${pkg.version} (${await buildLabel()})`);
  process.exit(0);
}

if (positionals.length === 1 && positionals[0] === "self-update") {
  process.exit(await selfUpdate({ channel: values.channel }));
}

// `bunker doctor` (read-only checks) and `bunker init` (interactive onboarding). `bunker -- init` is the prompt "init".
if (!process.argv.slice(2).includes("--") && positionals.length === 1 && (positionals[0] === "doctor" || positionals[0] === "init")) {
  const cmd = positionals[0];
  const others = Object.entries(values).filter(([k, v]) => !(k === "yes" && cmd === "init") && k !== "verbose" && v !== false && v !== undefined);
  if (others.length) {
    console.error(`bunker: ${cmd} only takes ${cmd === "init" ? "--yes" : "no options"}`);
    process.exit(2);
  }
  if (cmd === "doctor") {
    const r = await runDoctor({ cwd: process.cwd() });
    console.log(formatChecks(r.checks));
    process.exit(r.code);
  }
  if (!values.yes && !process.stdin.isTTY) {
    console.error("bunker: init is interactive and needs a terminal; pass --yes to accept the proposed defaults");
    process.exit(2);
  }
  process.exit(await runInit({ cwd: process.cwd(), yes: !!values.yes, io: terminalIo() }));
}

// `bunker clean`: dry run unless --yes.
if (positionals.length === 1 && positionals[0] === "clean") {
  const others = Object.entries(values).filter(([k, v]) => !["yes", "logs", "images", "force", "verbose"].includes(k) && v !== false && v !== undefined);
  if (others.length) {
    console.error("bunker: clean only takes --yes, --logs <days>, --images and --force");
    process.exit(2);
  }
  const logsDays = values.logs === undefined ? undefined : Number(values.logs);
  if (logsDays !== undefined && !(logsDays >= 0 && Number.isFinite(logsDays))) {
    console.error("bunker: --logs must be a number of days");
    process.exit(2);
  }
  const r = await runClean({ cwd: process.cwd(), yes: values.yes, logsDays, images: values.images, force: values.force });
  process.exit(r.code);
}

if (values.yes) {
  console.error("bunker: --yes only applies to init and clean");
  process.exit(2);
}
if (values.logs !== undefined || values.images || values.force) {
  console.error("bunker: --logs, --images and --force only apply to clean");
  process.exit(2);
}

// `bunker ui [--port <n>]`: the shared live view, a long-lived hub every run publishes to.
if (positionals.length === 1 && positionals[0] === "ui") {
  const others = Object.entries(values).filter(([k, v]) => k !== "port" && k !== "verbose" && v !== false && v !== undefined);
  if (others.length) {
    console.error("bunker: ui only takes --port");
    process.exit(2);
  }
  const port = values.port === undefined ? 4321 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("bunker: --port must be an integer between 0 and 65535");
    process.exit(2);
  }
  if (await hubReachable(port, readToken())) {
    console.log(`bunker: hub already running at http://127.0.0.1:${port}`);
    process.exit(0);
  }
  let hub;
  try {
    hub = startHub({ port, token: readToken() });
  } catch (e) {
    console.error(`bunker: could not start the hub: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log(`bunker: hub at ${hub.url} (Ctrl-C to quit)`);
  await new Promise(() => {});
}

const { config: repoCfg, legacy: legacyCfg } = await loadRepoConfigOrExit(process.cwd());
const prompt = positionals.join(" ");
const tasks = values.task ?? [];
let watchOpts: { intervalMs: number; maxCostDayUsd?: number; maxCostMonthUsd?: number; forMs?: number; auditEveryDays?: number } | undefined;
if (values.watch) {
  if (prompt || tasks.length || values.review || values.issue !== undefined || values.queue || values.audit || values.limit !== undefined) {
    console.error("bunker: --watch can't be combined with a prompt, --task, --review, --issue, --queue, --audit or --limit");
    process.exit(2);
  }
  const intervalMin = values.interval === undefined ? repoCfg.watch.interval ?? 10 : Number(values.interval);
  if (!(intervalMin > 0) || !Number.isFinite(intervalMin)) {
    console.error("bunker: --interval must be a positive number of minutes");
    process.exit(2);
  }
  if (values["max-cost"] !== undefined && values["max-cost-day"] !== undefined) {
    console.error("bunker: --max-cost is an alias of --max-cost-day; pass only one");
    process.exit(2);
  }
  const capArgs = { day: values["max-cost-day"] ?? values["max-cost"], month: values["max-cost-month"] };
  const fileCaps = await loadSpendCaps().catch((e) => (console.error(`bunker: ${e instanceof Error ? e.message : e}`), process.exit(2)));
  const caps: { day?: number; month?: number } = { ...(repoCfg.watch.max_cost_day === undefined ? {} : { day: repoCfg.watch.max_cost_day }), ...(repoCfg.watch.max_cost_month === undefined ? {} : { month: repoCfg.watch.max_cost_month }), ...fileCaps };
  for (const [k, flag] of [["day", values["max-cost-day"] === undefined ? "--max-cost" : "--max-cost-day"], ["month", "--max-cost-month"]] as const) {
    if (capArgs[k] === undefined) continue;
    const n = Number(capArgs[k]);
    if (!(n > 0) || !Number.isFinite(n)) {
      console.error(`bunker: ${flag} must be a positive number of US dollars`);
      process.exit(2);
    }
    caps[k] = n;
  }
  let auditEveryDays: number | undefined = repoCfg.watch.audit_every;
  if (values["audit-every"] !== undefined) {
    auditEveryDays = Number(values["audit-every"]);
    if (!(auditEveryDays > 0) || !Number.isFinite(auditEveryDays)) {
      console.error("bunker: --audit-every must be a positive number of days");
      process.exit(2);
    }
  }
  let forMs: number | undefined;
  if (values.for !== undefined) {
    forMs = parseDuration(values.for);
    if (forMs === undefined) {
      console.error('bunker: --for must be a duration like 5h, 90m or 2h30m');
      process.exit(2);
    }
  }
  if (!values.verify && !repoCfg.verify && !legacyCfg.verify && !existsSync(join(process.cwd(), ".bunker", "verify"))) {
    console.error("bunker: --watch needs a verify command: pass --verify \"<cmd>\" or set verify in .bunker/config.toml");
    process.exit(2);
  }
  watchOpts = { intervalMs: intervalMin * 60_000, ...(caps.day === undefined ? {} : { maxCostDayUsd: caps.day }), ...(caps.month === undefined ? {} : { maxCostMonthUsd: caps.month }), ...(forMs === undefined ? {} : { forMs }), ...(auditEveryDays === undefined ? {} : { auditEveryDays }) };
  values.queue = true;
  values.merge = true;
} else if (values.interval !== undefined || values.for !== undefined || values["max-cost"] !== undefined || values["max-cost-day"] !== undefined || values["max-cost-month"] !== undefined || values["audit-every"] !== undefined) {
  console.error("bunker: --interval, --for, --max-cost, --max-cost-day, --max-cost-month and --audit-every only apply to --watch");
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
} else if ((values["max-issues"] !== undefined && !values.watch) || values.focus !== undefined) {
  console.error("bunker: --max-issues only applies to --audit (or --watch --audit-every) and --focus only to --audit");
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
      '       bunker --queue [--setup "<cmd>"] [--verify "<cmd>" [--verify-on-host] [--merge [--ci-timeout <min>]]] [--limit <n>] [--parallel <n>]   (work the `bunker` label queue)\n' +
      '       bunker --watch [--interval <min>] [--for <duration>] [--max-cost-day <usd>] [--max-cost-month <usd>] [--parallel <n>] [--verify "<cmd>"]   (work the queue unattended, auto-merging)\n' +
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
if (values["allow-labeler"]?.length && values.issue === undefined && !values.queue) {
  console.error("bunker: --allow-labeler only applies to --issue, --queue or --watch");
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

const resume = !values["no-resume"];
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

let parallel = values.watch ? repoCfg.watch.parallel ?? 1 : 1;
if (values.parallel !== undefined) {
  parallel = Number(values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) {
    console.error("bunker: --parallel must be a positive integer");
    process.exit(2);
  }
  if (!values.queue) {
    console.error("bunker: --parallel only applies to --queue and --watch");
    process.exit(2);
  }
  if (parallel > 1 && !values.merge) {
    console.error("bunker: --parallel above 1 needs --merge (--watch always merges)");
    process.exit(2);
  }
}

await loadBunkerEnv(process.cwd());
if (!values["no-sandbox"] && !hasAuth()) {
  // On the host claude can use your login; in a container it only has what we pass in.
  console.error(AUTH_HINT);
  process.exit(2);
}

let ciTimeoutMin: number | undefined = values.merge ? repoCfg.merge.ci_timeout : undefined;
if (values["ci-timeout"] !== undefined) {
  ciTimeoutMin = Number(values["ci-timeout"]);
  if (!(ciTimeoutMin > 0) || !values.merge) {
    console.error("bunker: --ci-timeout must be a positive number of minutes and requires --merge");
    process.exit(2);
  }
}

const timeouts: { idleTimeoutMs?: number; completionTimeoutMs?: number; stepTimeoutMs?: number } = {};
for (const [flag, key, unit, ms] of [
  ["idle-timeout", "idleTimeoutMs", "minutes", 60_000],
  ["completion-timeout", "completionTimeoutMs", "seconds", 1000],
  ["step-timeout", "stepTimeoutMs", "minutes", 60_000],
] as const) {
  const raw = values[flag];
  if (raw === undefined) continue;
  const n = Number(raw);
  if (!(n > 0)) {
    console.error(`bunker: --${flag} must be a positive number of ${unit}`);
    process.exit(2);
  }
  timeouts[key] = n * ms;
}

if (values.verbose) output.verbose = true;
// The in-place progress line must not outlive the run.
process.on("exit", () => clearProgress());
const startedAt = Date.now();
process.on("exit", () => console.log(`bunker: elapsed ${formatDuration(Date.now() - startedAt)} (wall-clock)`));

const allowLabelers = [...(values["allow-labeler"] ?? []), ...(values.issue !== undefined || values.queue ? await configAllowedLabelers().catch((e) => (console.error(`bunker: ${e instanceof Error ? e.message : e}`), process.exit(2))) : [])];
const tty = !!process.stdout.isTTY;
const progress = createProgress({ write: (s) => output.write(redact(s)), tty, columns: process.stdout.columns ?? 100 });
// Publish to the shared hub when one is up; --ui makes sure there is one. No hub, no publishing, no errors.
let hub: Hub | undefined;
let publisher: Publisher | undefined;
const hubUrl = `http://127.0.0.1:${uiPort}`;
if (values.ui || values.audit || values.queue || values.issue !== undefined) {
  try {
    if (values.ui && !(await hubReachable(uiPort, readToken()))) {
      hub = startHub({ port: uiPort, token: readToken() });
    }
    if (values.ui || (await hubReachable(uiPort, readToken()))) {
      publisher = await connectHub({ port: hub?.server.port ?? uiPort, repo: await repoId(), token: readToken() });
    }
  } catch (e) {
    if (values.ui) {
      console.error(`bunker: could not start --ui: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    }
  }
  if (values.ui) console.log(`bunker: live view at ${hub?.url ?? hubUrl}`);
}
const onEvent = publisher ? (e: BunkerEvent) => (progress.onEvent(e), publisher.onEvent(e)) : progress.onEvent;
clearProgress = progress.clear;
// Keep the caller's checkout current (lags otherwise: .bunker/verify lookup, docs); --watch pulls on every pass itself.
const pull = !values["no-pull"] && !watchOpts && (values.audit || values.queue || values.issue !== undefined);
if (pull) {
  const r = await safePull(process.cwd());
  if (!r.pulled) console.log(r.message);
}
// Leftovers of earlier interrupted runs; --watch does the same once it holds its lock.
if (!watchOpts && (values.queue || values.issue !== undefined)) await runClean({ cwd: process.cwd(), yes: true, auto: true });
const models = resolveModels(values, process.env, repoCfg.models);
const agent = claudeCode({ model: models.implementer, json: true });
const reviewerAgent = () => (models.reviewer === models.implementer ? agent : claudeCode({ model: models.reviewer, json: true }));
const sandbox = values["no-sandbox"] ? noSandbox() : docker({ image: values.image });

if (values.audit) {
  let result;
  try {
    const auditor = claudeCode({ model: models.auditor, json: true });
    result = await runAudit({ agent: auditor, sandbox, maxIssues, focus: values.focus, setup: values.setup, onEvent, ...timeouts });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    await publisher?.flush();
    process.exit(2);
  }
  console.log();
  for (const t of result.skipped) console.log(`bunker: skipped (already open): ${t}`);
  for (const f of result.notFiled) console.log(`bunker: not filed (${f.severity ?? "medium"}): ${f.title}`);
  if (!result.filed.length) console.log("bunker: no issues filed");
  for (const f of result.filed) console.log(`filed #${f.number}: ${f.title}`);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
} else if (watchOpts) {
  const reviewer = reviewerAgent();
  const ctl = new AbortController();
  // The first signal finishes the current step and exits 0; a second one quits now.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (ctl.signal.aborted) process.exit(130);
      console.log(`bunker: ${sig} received; finishing the current step, then exiting (again to quit now)`);
      ctl.abort();
    });
  }
  const notify = desktopNotifier({ enabled: !values["no-notify"] && repoCfg.notify.enabled !== false });
  const ghToken = process.env.BUNKER_GH_TOKEN;
  const mention = await resolveMention(process.cwd(), (ghToken ? { ...process.env, GH_TOKEN: ghToken } : process.env) as Record<string, string>, repoCfg.notify.github_user);
  try {
    await runWatch({ notify, mention, onEvent, agent, reviewer, sandbox, maxRounds, resume, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], verifyNetwork: repoCfg.verify_network === true, ciTimeoutMin, ...timeouts, parallel, allowLabelers, cleanOnStart: true, signal: ctl.signal, pull: !values["no-pull"], maxIssues, auditor: claudeCode({ model: models.auditor, json: true }), ...watchOpts });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    await publisher?.flush();
    process.exit(2);
  }
} else if (values.queue) {
  const reviewer = reviewerAgent();
  let results;
  try {
    results = await runQueue({ onEvent, agent, reviewer, sandbox, maxRounds, resume, limit, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], verifyNetwork: repoCfg.verify_network === true, merge: values.merge, ciTimeoutMin, ...timeouts, parallel, allowLabelers });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    await publisher?.flush();
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
  const pausedRun = results.find((r) => r.status === "paused-usage-limit");
  if (pausedRun) {
    console.log(`bunker: paused on the Claude usage limit (#${pausedRun.issue}); ${rerunHint(pausedRun.pause?.resetAt)}`);
    process.exitCode = 3;
  } else if (results.some((r) => r.status !== "blocked" && r.status !== "already-in-progress" && r.status !== (values.merge ? "merged" : "pr-opened"))) process.exitCode = 1;
} else if (values.issue !== undefined) {
  const issue = Number(values.issue);
  if (!Number.isInteger(issue) || issue < 1) {
    console.error("bunker: --issue must be a positive integer");
    await publisher?.flush();
    process.exit(2);
  }
  const reviewer = reviewerAgent();
  let result;
  try {
    const token = process.env.BUNKER_GH_TOKEN;
    const ghEnv = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
    if (!(await enforceLabeler(issue, { cwd: process.cwd(), env: ghEnv, allow: allowLabelers }))) {
      await publisher?.flush();
      process.exit(1);
    }
    result = await runIssue({ onEvent, issue, agent, reviewer, sandbox, maxRounds, resume, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], verifyNetwork: repoCfg.verify_network === true, merge: values.merge, ciTimeoutMin, ...timeouts });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    await publisher?.flush();
    process.exit(2);
  }
  console.log();
  for (const [i, r] of (result.review?.rounds ?? []).entries()) {
    console.log(`bunker: round ${i + 1}: ${r.commits.length} commit(s), ${r.approved ? "approved" : "changes requested"}`);
  }
  console.log(`bunker: [${result.status}] ${result.branch} (worktree ${result.worktree})`);
  if (result.status === "paused-usage-limit") console.log(`bunker: paused on the Claude usage limit; ${rerunHint(result.pause?.resetAt)}`);
  if (result.error) console.log(`  ${result.error.trimEnd().replaceAll("\n", "\n  ")}`);
  if (result.prUrl) console.log(result.prUrl);
  if (result.review?.usage) console.log(`bunker: cost ${formatUsage(result.review.usage)}`);
  if (result.logPath) console.log(`bunker: log ${tty ? hyperlink(result.logPath) : result.logPath}`);
  if (result.status === "paused-usage-limit") process.exitCode = 3;
  else if (result.status !== (values.merge ? "merged" : "pr-opened")) process.exitCode = 1;
} else if (values.review) {
  const reviewer = reviewerAgent();
  const result = await review({ onEvent, prompt, agent, reviewer, sandbox, maxRounds, resume, ...timeouts });
  console.log();
  for (const [i, r] of result.rounds.entries()) {
    console.log(`bunker: round ${i + 1}: ${r.commits.length} commit(s), ${r.approved ? "approved" : "changes requested"}`);
  }
  console.log(`bunker: [${result.status}] ${result.branch} (${result.commits.length} commit(s))`);
  for (const c of result.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
  if (result.error) console.log(`  ${result.error.trimEnd().replaceAll("\n", "\n  ")}`);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
  if (result.status === "paused-usage-limit") {
    // Nothing resumes a plain --review, so don't leak the kept worktree; the branch keeps the committed work.
    if (result.pause) await worktreeAdmin(process.cwd(), () => $`git -C ${process.cwd()} worktree remove --force ${result.pause!.worktree}`.nothrow().quiet());
    console.log(`bunker: paused on the Claude usage limit; work kept on ${result.branch}; ${rerunHint(result.pause?.resetAt)}`);
    await publisher?.flush();
    process.exit(3);
  }
  if (result.status !== "approved") { await publisher?.flush(); process.exit(1); }
} else if (prompt) {
  let result;
  try {
    result = await run({ onEvent, prompt, agent, sandbox, maxIterations, resume, ...timeouts });
  } catch (e) {
    if (e instanceof UsageLimit) {
      console.log(`\nbunker: paused on the Claude usage limit; ${rerunHint(e.resetAt)}`);
      await publisher?.flush();
      process.exit(3);
    }
    console.error(`\nbunker: ${e instanceof Error ? e.message : e}`);
    if (e instanceof AgentFailure && e.usage) console.log(`bunker: cost ${formatUsage(e.usage)}`);
    await publisher?.flush();
    process.exit(1);
  }
  console.log(`\nbunker: ${result.commits.length} commit(s) merged from ${result.branch}`);
  for (const c of result.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
} else {
  const results = await runAll({ onEvent, tasks: tasks.map((p) => ({ prompt: p })), agent, sandbox, maxIterations, resume, ...timeouts });
  console.log();
  for (const r of results) {
    console.log(`bunker: [${r.status}] ${r.branch} (${r.commits.length} commit(s)) ${r.prompt}`);
    for (const c of r.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
    if (r.usage) console.log(`  cost ${formatUsage(r.usage)}`);
    if (r.error) console.log(`  ${r.error.trimEnd().replaceAll("\n", "\n  ")}`);
  }
  if (results.some((r) => r.status !== "merged")) { await publisher?.flush(); process.exit(1); }
}

await publisher?.flush();
if (hub) {
  if (values["ui-keep"]) {
    console.log(`bunker: run finished; still serving ${hub.url} (Ctrl-C to quit)`);
    await new Promise(() => {});
  }
  await hub.stop();
}
