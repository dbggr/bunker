#!/usr/bin/env bun
import { liveGhEnv } from "../github/identity.ts";
import { parseArgs } from "node:util";
import { resolveCiTimeout, resolveParallel, resolveTimeouts, resolveWatchSettings } from "../core/settings.ts";
import { AUTH_HINT, hasAuth, loadBunkerEnv } from "../core/env.ts";
import { $ } from "bun";
import { hardenHostGit } from "../sandboxes/git-guard.ts";
import { AgentFailure, UsageLimit } from "../pipeline/errors.ts";
import { review } from "../pipeline/review.ts";
import { run, runAll } from "../pipeline/run.ts";
import { worktreeAdmin } from "../worktree/admin.ts";
import { SkillError, loadSkills } from "../core/skills.ts";
import { docker, stopLiveContainers } from "../sandboxes/container.ts";
import { abandonLive } from "../pipeline/issue-cleanup.ts";
import { createInterrupt } from "./commands/interrupt.ts";
import { noSandbox } from "../sandboxes/no-sandbox.ts";
import { formatDuration, formatUsage } from "../agents/agent.ts";
import { claudeCode } from "../agents/claude.ts";
import { loadRepoConfigOrExit } from "../core/config.ts";
import { resolveModels } from "../agents/models.ts";
import { runAudit } from "../pipeline/audit.ts";
import { loadSpendCaps } from "../core/spend.ts";
import { configAllowedLabelers } from "../github/labeler.ts";
import { parseDuration, runWatch } from "./commands/watch.ts";
import { desktopNotifier, resolveMention } from "../core/notify.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyIdentity, identityKind } from "../github/identity.ts";
import { parseGithubRemote } from "./commands/doctor.ts";
import { redact } from "../core/redact.ts";
import { createProgress, emit, type BunkerEvent } from "../core/events.ts";
import { connectHub, defaultHubPort, hubHistoryDir, hubReachable, readToken, repoId, startHub, viewUrlFor, type Hub, type Publisher } from "../ui/ui.ts";
import { COMMAND_HELP, HELP } from "./commands/help.ts";
import { MODES, resolveMode, type Mode } from "./modes.ts";
import { options } from "../core/options.ts";
import { output } from "../core/output.ts";
import { safePull } from "../github/pull.ts";
import { runClean } from "./commands/clean.ts";
import { selfUpdate } from "./commands/self-update.ts";
import { buildLabel } from "../build-info.ts";
import pkg from "../../package.json" with { type: "json" };
import { guardFlags } from "./args.ts";
import { cleanCommand, doctorOrInitCommand, shepherdCommand, statusCommand, triageCommand, uiCommand } from "./subcommands.ts";
import { issueCommand, queueCommand, rerunHint } from "./pipeline-commands.ts";

// Every git bunker runs on the host ignores repo hooks and fsmonitor (see git-guard.ts).
hardenHostGit();

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
const { values } = parsed;
let positionals = parsed.positionals;
const literal = process.argv.slice(2).includes("--");
const isTriage = !process.argv.slice(2).includes("--") && positionals.length === 1 && positionals[0] === "triage";

if (values.help) {
  const first = literal ? undefined : positionals[0];
  console.log((MODES as readonly string[]).includes(first ?? "") ? COMMAND_HELP[first as Mode] : HELP);
  process.exit(0);
}

// An agent in a bunker container holds a GitHub token; it must not drive the live queue (or any run) from there.
if (process.env.BUNKER_IN_SANDBOX) {
  console.error("bunker: refusing to run inside a bunker sandbox (BUNKER_IN_SANDBOX is set); run bunker on the host");
  process.exit(2);
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
  await doctorOrInitCommand(values, positionals);
}

// `bunker status`: read-only summary of the watcher, its runs, the queue and the spend.
if (positionals.length === 1 && positionals[0] === "status") {
  await statusCommand(values);
}

// `bunker mcp`: a stdio MCP server that manages local watches (systemd user units).
if (positionals.length === 1 && positionals[0] === "mcp") {
  const { serveStdio } = await import("../mcp/server.ts");
  await serveStdio();
  process.exit(0);
}

// `bunker clean`: dry run unless --yes.
if (positionals.length === 1 && positionals[0] === "clean") {
  await cleanCommand(values);
}

// `bunker ui [--port <n>]`: the shared live view, a long-lived hub every run publishes to.
if (positionals.length === 1 && positionals[0] === "ui") {
  await uiCommand(values);
}

// `bunker triage`: a read-only agent checks open `discovered` issues; dry run unless --yes.
if (isTriage) {
  await triageCommand(values);
}

// `bunker shepherd`: one pass of the PR shepherd over the open bunker PRs.
if (!process.argv.slice(2).includes("--") && positionals.length === 1 && positionals[0] === "shepherd") {
  await shepherdCommand(values);
}

const resolved = guardFlags(() => resolveMode(values, positionals, literal));
positionals = resolved.positionals;
const { config: repoCfg } = await loadRepoConfigOrExit(process.cwd());
const prompt = positionals.join(" ");
const tasks = values.task ?? [];
// Manual-merge mode: the run ends at an open PR a human merges (`merge = "manual"` in config.toml, or `bunker watch --no-merge`).
const manual = !!values["no-merge"] || (repoCfg.merge.mode === "manual" && (!!values.watch || !!values.queue || values.issue !== undefined));
if (manual && values.merge) {
  console.error('bunker: --merge conflicts with manual-merge mode (--no-merge or merge = "manual" in .bunker/config.toml)');
  process.exit(2);
}
let watchOpts: { intervalMs: number; maxCostDayUsd?: number; maxCostMonthUsd?: number; forMs?: number; auditEveryDays?: number; triageEveryHours?: number } | undefined;
if (values.watch) {
  const fileCaps = await loadSpendCaps().catch((e) => (console.error(`bunker: ${e instanceof Error ? e.message : e}`), process.exit(2)));
  const { intervalMin, caps, auditEveryDays, triageEveryHours } = guardFlags(() => resolveWatchSettings(values, repoCfg.watch, fileCaps));
  let forMs: number | undefined;
  if (values.for !== undefined) {
    forMs = parseDuration(values.for);
    if (forMs === undefined) {
      console.error('bunker: --for must be a duration like 5h, 90m or 2h30m');
      process.exit(2);
    }
  }
  if (!values.verify && !repoCfg.verify) {
    console.error('bunker: watch needs a verify command: pass --verify "<cmd>" or set verify in .bunker/config.toml');
    process.exit(2);
  }
  watchOpts = { intervalMs: intervalMin * 60_000, ...(caps.day === undefined ? {} : { maxCostDayUsd: caps.day }), ...(caps.month === undefined ? {} : { maxCostMonthUsd: caps.month }), ...(forMs === undefined ? {} : { forMs }), ...(auditEveryDays === undefined ? {} : { auditEveryDays }), ...(triageEveryHours === undefined ? {} : { triageEveryHours }) };
  values.queue = true;
  values.merge = !manual;
}
const maxIssues = values["max-issues"] === undefined ? 5 : Number(values["max-issues"]);
if (!Number.isInteger(maxIssues) || maxIssues < 1) {
  console.error("bunker: --max-issues must be a positive integer");
  process.exit(2);
}
if (!values.audit && values.issue === undefined && !values.queue && !prompt === !tasks.length) {
  console.error(
    'usage: bunker "<prompt>" [--model <id>] [--image <name>] [--no-sandbox] [--max-iterations <n>]\n' +
      '       bunker review "<prompt>" [--max-rounds <n>] [--reviewer-model <id>]   (implement → review → fix)\n' +
      '       bunker issue <n> [--setup "<cmd>"] [--verify "<cmd>" [--verify-on-host] [--merge [--ci-timeout <min>]]] [--max-rounds <n>] [--reviewer-model <id>]   (issue → reviewed PR)\n' +
      '       bunker queue [--setup "<cmd>"] [--verify "<cmd>" [--verify-on-host] [--merge [--ci-timeout <min>]]] [--limit <n>] [--parallel <n>]   (work the `bunker:queued` label queue)\n' +
      '       bunker watch [--interval <min>] [--for <duration>] [--max-cost-day <usd>] [--max-cost-month <usd>] [--parallel <n>] [--verify "<cmd>"]   (work the queue unattended, auto-merging)\n' +
      '       bunker watch --no-merge   (or merge = "manual" in config.toml: PRs wait for you to merge them)\n' +
      '       bunker shepherd   (one pass over the open bunker PRs: CI fixes, branch updates, conflicts)\n' +
      '       bunker audit [--max-issues <n>] [--focus "<text>"] [--setup "<cmd>"]   (file improvement ideas as `discovered` issues)\n' +
      '       bunker task "<prompt>" "<prompt>" ...   (parallel, one worktree each)\n' +
      "run bunker --help for all options",
  );
  process.exit(2);
}

if (!values.ui && (values.port !== undefined || values["ui-keep"])) {
  console.error("bunker: --port and --ui-keep only apply to --ui");
  process.exit(2);
}
const uiPort = values.port === undefined ? defaultHubPort() : Number(values.port);
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

const limit = values.limit === undefined ? 5 : Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) {
  console.error("bunker: --limit must be a positive integer");
  process.exit(2);
}

const parallel = guardFlags(() => resolveParallel(values, repoCfg.watch, manual));

await loadBunkerEnv(process.cwd());
if (identityKind(process.env) !== "pat") {
  // Opt-in separate GitHub identity: from here on BUNKER_GH_TOKEN is that identity's token.
  const origin = await $`git remote get-url origin`.quiet().nothrow();
  const slug = parseGithubRemote(origin.stdout.toString())?.slug;
  try {
    if (!slug) throw new Error("a separate GitHub identity needs a GitHub origin remote");
    await applyIdentity(process.env, slug);
  } catch (e) {
    console.error(`bunker: ${redact(e instanceof Error ? e.message : String(e))}`);
    process.exit(2);
  }
}
if (!values["no-sandbox"] && !hasAuth()) {
  // On the host claude can use your login; in a container it only has what we pass in.
  console.error(AUTH_HINT);
  process.exit(2);
}

const ciTimeoutMin = guardFlags(() => resolveCiTimeout(values, repoCfg.merge));

const timeouts = guardFlags(() => resolveTimeouts(values));

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
if (values.ui || values.audit || values.queue || values.issue !== undefined) {
  try {
    if (values.ui && !(await hubReachable(uiPort, readToken()))) {
      hub = startHub({ port: uiPort, token: readToken(), historyDir: hubHistoryDir() });
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
  if (values.ui) console.log(`bunker: live view at ${hub?.viewUrl ?? viewUrlFor(uiPort, readToken())}`);
}
const onEvent = publisher ? (e: BunkerEvent) => (progress.onEvent(e), publisher.onEvent(e)) : progress.onEvent;
clearProgress = progress.clear;
// Keep the caller's checkout current (lags otherwise: .bunker/verify config lookup, docs); bunker watch pulls on every pass itself.
const pull = !values["no-pull"] && !watchOpts && (values.audit || values.queue || values.issue !== undefined);
if (pull) {
  const r = await safePull(process.cwd());
  if (!r.pulled) console.log(r.message);
}
// Leftovers of earlier interrupted runs; bunker watch does the same once it holds its lock.
if (!watchOpts && (values.queue || values.issue !== undefined)) await runClean({ cwd: process.cwd(), yes: true, auto: true, logsDays: repoCfg.clean.logs_days ?? 30 });
const models = resolveModels(values, process.env, repoCfg.models);
const agent = claudeCode({ model: models.implementer, json: true });
const reviewerAgent = () => (models.reviewer === models.implementer ? agent : claudeCode({ model: models.reviewer, json: true }));
const skills = await loadSkills(process.cwd()).catch((e) => {
  if (!(e instanceof SkillError)) throw e;
  console.error(`bunker: ${e.message}`);
  process.exit(2);
});
const sandbox = values["no-sandbox"] ? noSandbox({ skills }) : docker({ image: values.image, skills });

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
  // The first signal stops new work and finishes the in-flight steps (exit 0); a second one kills the agents, re-queues and exits 130.
  const intr = createInterrupt({
    ctl,
    log: (l) => console.log(l),
    exit: (code) => process.exit(code),
    stopContainers: stopLiveContainers,
    ...(timeouts.stepTimeoutMs ? { stepTimeoutMs: timeouts.stepTimeoutMs } : {}),
    requeue: async (n) => {
      const kept = await abandonLive(n);
      if (kept) console.log(`bunker: #${n}: work kept as tag ${kept}`);
      await $`gh issue edit ${n} --remove-label bunker:in-progress --add-label bunker:queued`.env(liveGhEnv()).nothrow().quiet();
    },
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void intr.signal(sig));
  const watchEvent = (e: BunkerEvent) => (intr.onEvent(e), onEvent(e));
  const notify = desktopNotifier({ enabled: !values["no-notify"] && repoCfg.notify.enabled !== false && !process.env.BUNKER_TEST_NO_NOTIFY });
    const mention = await resolveMention(process.cwd(), liveGhEnv(), repoCfg.notify.github_user);
  try {
    await runWatch({ notify, mention, onEvent: watchEvent, agent, reviewer, sandbox, maxRounds, resume, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], verifyNetwork: repoCfg.verify_network === true, manual, ciTimeoutMin, ...timeouts, parallel, allowLabelers, cleanOnStart: true, logsDays: repoCfg.clean.logs_days ?? 30, signal: ctl.signal, pull: !values["no-pull"], maxIssues, auditor: claudeCode({ model: models.auditor, json: true }), ...watchOpts });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    await publisher?.flush();
    process.exit(2);
  }
  intr.finish();
} else if (values.queue) {
  await queueCommand({ manual, values, repoCfg, onEvent, agent, reviewerAgent, sandbox, maxRounds, resume, limit, ciTimeoutMin, timeouts, parallel, allowLabelers, publisher, tty });
} else if (values.issue !== undefined) {
  await issueCommand({ manual, values, repoCfg, onEvent, agent, reviewerAgent, sandbox, maxRounds, resume, limit, ciTimeoutMin, timeouts, parallel, allowLabelers, publisher, tty });
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
    // Nothing resumes a plain bunker review, so don't leak the kept worktree; the branch keeps the committed work.
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
    console.log(`bunker: run finished; still serving ${hub.viewUrl} (Ctrl-C to quit)`);
    await new Promise(() => {});
  }
  await hub.stop();
}
