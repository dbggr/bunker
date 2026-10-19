import { liveGhEnv } from "../github/identity.ts";
import { $ } from "bun";
import { resolveTimeouts } from "../core/settings.ts";
import { AUTH_HINT, hasAuth, loadBunkerEnv } from "../core/env.ts";
import { SkillError, loadSkills } from "../core/skills.ts";
import { docker } from "../sandboxes/container.ts";
import { noSandbox } from "../sandboxes/no-sandbox.ts";
import { formatUsage } from "../agents/agent.ts";
import { claudeCode } from "../agents/claude.ts";
import { loadRepoConfigOrExit } from "../core/config.ts";
import { resolveModels } from "../agents/models.ts";
import { formatChecks, runDoctor } from "./commands/doctor.ts";
import { runInit, terminalIo } from "./commands/init.ts";
import { runTriage, formatTriage } from "../pipeline/triage.ts";
import { loadSpendCaps } from "../core/spend.ts";
import { redact } from "../core/redact.ts";
import { createProgress } from "../core/events.ts";
import { defaultHubPort, hubHistoryDir, hubReachable, readToken, startHub, viewUrlFor } from "../ui/ui.ts";
import { output } from "../core/output.ts";
import { runClean } from "./commands/clean.ts";
import { collectStatus, formatStatus } from "./commands/status.ts";
import { listQueued } from "../github/queue.ts";
import { listBlocked } from "../github/issues.ts";
import { alive } from "./commands/watch.ts";
import { guardFlags, type CliValues } from "./args.ts";
import { createShepherd } from "../pipeline/shepherd.ts";
import { rerunHint } from "./pipeline-commands.ts";

export async function doctorOrInitCommand(values: CliValues, positionals: string[]) {
  const cmd = positionals[0];
  const others = Object.entries(values).filter(([k, v]) => !((k === "yes" || k === "explain") && cmd === "init") && k !== "verbose" && v !== false && v !== undefined);
  if (others.length) {
    console.error(`bunker: ${cmd} only takes ${cmd === "init" ? "--yes and --explain <step>" : "no options"}`);
    process.exit(2);
  }
  if (cmd === "doctor") {
    const r = await runDoctor({ cwd: process.cwd() });
    console.log(formatChecks(r.checks));
    process.exit(r.code);
  }
  if (values.explain !== undefined) process.exit(await runInit({ cwd: process.cwd(), yes: false, explain: values.explain, tty: !!process.stdout.isTTY, columns: process.stdout.columns, io: terminalIo() }));
  if (!values.yes && !process.stdin.isTTY) {
    console.error("bunker: init is interactive and needs a terminal; pass --yes to accept the proposed defaults");
    process.exit(2);
  }
  // Ctrl-C outside a prompt (a docker build, say): exit through the normal hooks so containers are stopped
  process.on("SIGINT", () => process.exit(130));
  process.exit(await runInit({ cwd: process.cwd(), yes: !!values.yes, tty: !!process.stdout.isTTY, columns: process.stdout.columns, io: terminalIo() }));
}

export async function statusCommand(values: CliValues) {
  const others = Object.entries(values).filter(([k, v]) => !["json", "verbose"].includes(k) && v !== false && v !== undefined);
  if (others.length) {
    console.error("bunker: status only takes --json");
    process.exit(2);
  }
  const cwd = process.cwd();
  const repo = (await $`git -C ${cwd} rev-parse --show-toplevel`.nothrow().quiet().text()).trim();
  if (!repo) {
    console.error("bunker: status must be run inside a git repository");
    process.exit(2);
  }
  const cfg = (await loadRepoConfigOrExit(repo)).config;
  const fileCaps = await loadSpendCaps().catch(() => ({}));
  const caps = { ...(cfg.watch.max_cost_day === undefined ? {} : { day: cfg.watch.max_cost_day }), ...(cfg.watch.max_cost_month === undefined ? {} : { month: cfg.watch.max_cost_month }), ...fileCaps };
  const env = liveGhEnv();
  const report = await collectStatus({ repo, caps, alive, queue: () => listQueued(repo, env), blocked: () => listBlocked(repo, env) });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatStatus(report));
  process.exit(0);
}

export async function cleanCommand(values: CliValues) {
  const others = Object.entries(values).filter(([k, v]) => !["yes", "logs", "images", "force", "verbose"].includes(k) && v !== false && v !== undefined);
  if (others.length) {
    console.error("bunker: clean only takes --yes, --logs <days>, --images and --force");
    process.exit(2);
  }
  const logsDays = values.logs === undefined ? (await loadRepoConfigOrExit(process.cwd())).config.clean.logs_days : Number(values.logs);
  if (logsDays !== undefined && !(logsDays >= 0 && Number.isFinite(logsDays))) {
    console.error("bunker: --logs must be a number of days");
    process.exit(2);
  }
  const r = await runClean({ cwd: process.cwd(), yes: values.yes, logsDays, images: values.images, force: values.force });
  process.exit(r.code);
}

export async function uiCommand(values: CliValues) {
  const others = Object.entries(values).filter(([k, v]) => k !== "port" && k !== "verbose" && v !== false && v !== undefined);
  if (others.length) {
    console.error("bunker: ui only takes --port");
    process.exit(2);
  }
  const port = values.port === undefined ? defaultHubPort() : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("bunker: --port must be an integer between 0 and 65535");
    process.exit(2);
  }
  if (await hubReachable(port, readToken())) {
    console.log(`bunker: hub already running at ${viewUrlFor(port, readToken())}`);
    process.exit(0);
  }
  let hub;
  try {
    hub = startHub({ port, token: readToken(), historyDir: hubHistoryDir() });
  } catch (e) {
    console.error(`bunker: could not start the hub: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log(`bunker: hub at ${hub.viewUrl} (Ctrl-C to quit)`);
  await new Promise(() => {});
}

export async function triageCommand(values: CliValues) {
  const others = Object.entries(values).filter(([k, v]) => !["yes", "limit", "setup", "model", "auditor-model", "image", "no-sandbox", "idle-timeout", "completion-timeout", "step-timeout", "verbose"].includes(k) && v !== false && v !== undefined);
  if (others.length) {
    console.error("bunker: triage only takes --yes, --limit, --setup, --model, --auditor-model, --image, --no-sandbox and the timeouts");
    process.exit(2);
  }
  const triageLimit = values.limit === undefined ? 10 : Number(values.limit);
  if (!Number.isInteger(triageLimit) || triageLimit < 1) {
    console.error("bunker: --limit must be a positive integer");
    process.exit(2);
  }
  const cfg = (await loadRepoConfigOrExit(process.cwd())).config;
  await loadBunkerEnv(process.cwd());
  if (!values["no-sandbox"] && !hasAuth()) {
    console.error(AUTH_HINT);
    process.exit(2);
  }
  const triageTimeouts = guardFlags(() => resolveTimeouts(values));
  if (values.verbose) output.verbose = true;
  const models = resolveModels(values, process.env, cfg.models);
  const mode = values.yes ? "label" : "dry";
  let result;
  try {
    result = await runTriage({ agent: claudeCode({ model: models.auditor, json: true }), sandbox: values["no-sandbox"] ? noSandbox() : docker({ image: values.image }), mode, limit: triageLimit, setup: values.setup, onEvent: createProgress({ write: (s) => output.write(redact(s)), tty: !!process.stdout.isTTY, columns: process.stdout.columns ?? 100 }).onEvent, ...triageTimeouts });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log();
  for (const line of formatTriage(result, mode)) console.log(line);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
  process.exit(0);
}

export async function shepherdCommand(values: CliValues) {
  const allowed = ["setup", "verify", "verify-on-host", "model", "implementer-model", "reviewer-model", "image", "no-sandbox", "idle-timeout", "completion-timeout", "step-timeout", "verbose"];
  const others = Object.entries(values).filter(([k, v]) => !allowed.includes(k) && v !== false && v !== undefined);
  if (others.length) {
    console.error("bunker: shepherd only takes --setup, --verify, --verify-on-host, --model, --implementer-model, --reviewer-model, --image, --no-sandbox and the timeouts");
    process.exit(2);
  }
  const cfg = (await loadRepoConfigOrExit(process.cwd())).config;
  await loadBunkerEnv(process.cwd());
  if (!values["no-sandbox"] && !hasAuth()) {
    console.error(AUTH_HINT);
    process.exit(2);
  }
  const timeouts = guardFlags(() => resolveTimeouts(values));
  if (values.verbose) output.verbose = true;
  const models = resolveModels(values, process.env, cfg.models);
  const skills = await loadSkills(process.cwd()).catch((e) => {
    if (!(e instanceof SkillError)) throw e;
    console.error(`bunker: ${e.message}`);
    process.exit(2);
  });
  const agent = claudeCode({ model: models.implementer, json: true });
  const shepherd = createShepherd({
    agent, reviewer: models.reviewer === models.implementer ? agent : claudeCode({ model: models.reviewer, json: true }),
    sandbox: values["no-sandbox"] ? noSandbox({ skills }) : docker({ image: values.image, skills }),
    ...(values.setup ? { setup: values.setup } : {}), ...(values.verify ? { verify: values.verify } : {}), verifyOnHost: values["verify-on-host"], verifyNetwork: cfg.verify_network === true,
    onEvent: createProgress({ write: (s) => output.write(redact(s)), tty: !!process.stdout.isTTY, columns: process.stdout.columns ?? 100 }).onEvent, ...timeouts,
  });
  const pass = await shepherd.pass();
  console.log();
  if (pass.error) {
    console.error(`bunker: ${pass.error}`);
    process.exit(2);
  }
  if (!pass.entries.length) console.log("bunker: no open bunker PRs");
  for (const e of pass.entries) console.log(`#${e.issue} PR #${e.pr} [${e.action}] ${e.url}${e.detail ? `\n  ${e.detail.trimEnd().replaceAll("\n", "\n  ")}` : ""}`);
  if (pass.paused) console.log(`bunker: paused on the Claude usage limit; ${rerunHint(pass.paused.resetAt)}`);
  if (pass.usage) console.log(`bunker: cost ${formatUsage(pass.usage)}`);
  process.exit(pass.paused ? 3 : pass.entries.some((e) => e.action === "gave-up" || e.action === "failed") ? 1 : 0);
}
