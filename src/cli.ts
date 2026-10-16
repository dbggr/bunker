#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { AUTH_HINT, hasAuth, loadBunkerEnv } from "./env.ts";
import { claudeCode, formatUsage, docker, noSandbox, review, run, runAll } from "./index.ts";
import { runAudit } from "./audit.ts";
import { runIssue, runQueue } from "./issue.ts";
import { redact } from "./redact.ts";
import pkg from "../package.json" with { type: "json" };

// Everything the CLI prints goes through redact().
for (const method of ["log", "error", "warn"] as const) {
  const orig = console[method].bind(console);
  console[method] = (...args: unknown[]) => orig(...args.map((a) => (typeof a === "string" ? redact(a) : a)));
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "no-sandbox": { type: "boolean", default: false },
    image: { type: "string" },
    model: { type: "string" },
    task: { type: "string", multiple: true },
    "max-iterations": { type: "string" },
    review: { type: "boolean", default: false },
    "max-rounds": { type: "string" },
    "reviewer-model": { type: "string" },
    issue: { type: "string" },
    setup: { type: "string" },
    verify: { type: "string" },
    "verify-on-host": { type: "boolean", default: false },
    merge: { type: "boolean", default: false },
    "ci-timeout": { type: "string" },
    queue: { type: "boolean", default: false },
    limit: { type: "string" },
    audit: { type: "boolean", default: false },
    "max-issues": { type: "string" },
    focus: { type: "string" },
    version: { type: "boolean", default: false },
  },
});

if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

const prompt = positionals.join(" ");
const tasks = values.task ?? [];
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
if (values.audit) {
  // checked above
} else if (values.queue) {
  if (prompt || tasks.length || values.review || values.issue !== undefined) {
    console.error("bunker: --queue can't be combined with a prompt, --task, --review or --issue");
    process.exit(2);
  }
  if (values.merge && values.verify === undefined) {
    console.error("bunker: --merge requires --verify");
    process.exit(2);
  }
  if (values["verify-on-host"] && values.verify === undefined) {
    console.error("bunker: --verify-on-host requires --verify");
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
  if (values.merge && values.verify === undefined) {
    console.error("bunker: --merge requires --verify");
    process.exit(2);
  }
  if (values["verify-on-host"] && values.verify === undefined) {
    console.error("bunker: --verify-on-host requires --verify");
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
      '       bunker --audit [--max-issues <n>] [--focus "<text>"] [--setup "<cmd>"]   (file improvement ideas as `discovered` issues)\n' +
      '       bunker --task "<prompt>" --task "<prompt>" ...   (parallel, one worktree each)',
  );
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
} else if (values.queue) {
  const reviewer = values["reviewer-model"] ? claudeCode({ model: values["reviewer-model"], json: true }) : agent;
  let results;
  try {
    results = await runQueue({ agent, reviewer, sandbox, maxRounds, limit, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], merge: values.merge, ciTimeoutMin });
  } catch (e) {
    console.error(`bunker: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log();
  if (!results.length) console.log("bunker: queue is empty");
  for (const r of results) {
    console.log(`#${r.issue} [${r.status}] ${r.prUrl ?? "-"}`);
    if (r.error) console.log(`  ${r.error.trimEnd().replaceAll("\n", "\n  ")}`);
    if (r.logPath) console.log(`  log: ${r.logPath}`);
    if (r.review?.usage) console.log(`  cost ${formatUsage(r.review.usage)}`);
    for (const f of r.filed) console.log(`  filed #${f.number}: ${f.title}`);
  }
  if (results.some((r) => r.status !== (values.merge ? "merged" : "pr-opened"))) process.exit(1);
} else if (values.issue !== undefined) {
  const issue = Number(values.issue);
  if (!Number.isInteger(issue) || issue < 1) {
    console.error("bunker: --issue must be a positive integer");
    process.exit(2);
  }
  const reviewer = values["reviewer-model"] ? claudeCode({ model: values["reviewer-model"], json: true }) : agent;
  let result;
  try {
    result = await runIssue({ issue, agent, reviewer, sandbox, maxRounds, setup: values.setup, verify: values.verify, verifyOnHost: values["verify-on-host"], merge: values.merge, ciTimeoutMin });
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
  if (result.verifyOutput) console.log(`  verify output:\n${result.verifyOutput}`);
  if (result.prUrl) console.log(result.prUrl);
  if (result.review?.usage) console.log(`bunker: cost ${formatUsage(result.review.usage)}`);
  if (result.logPath) console.log(`bunker: log ${result.logPath}`);
  if (result.status !== (values.merge ? "merged" : "pr-opened")) process.exit(1);
} else if (values.review) {
  const reviewer = values["reviewer-model"] ? claudeCode({ model: values["reviewer-model"], json: true }) : agent;
  const result = await review({ prompt, agent, reviewer, sandbox, maxRounds });
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
  const result = await run({ prompt, agent, sandbox, maxIterations });
  console.log(`\nbunker: ${result.commits.length} commit(s) merged from ${result.branch}`);
  for (const c of result.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
  if (result.usage) console.log(`bunker: cost ${formatUsage(result.usage)}`);
} else {
  const results = await runAll({ tasks: tasks.map((p) => ({ prompt: p })), agent, sandbox, maxIterations });
  console.log();
  for (const r of results) {
    console.log(`bunker: [${r.status}] ${r.branch} (${r.commits.length} commit(s)) ${r.prompt}`);
    for (const c of r.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
    if (r.usage) console.log(`  cost ${formatUsage(r.usage)}`);
    if (r.error) console.log(`  ${r.error.trimEnd().replaceAll("\n", "\n  ")}`);
  }
  if (results.some((r) => r.status !== "merged")) process.exit(1);
}
