#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { AUTH_HINT, hasAuth, loadBunkerEnv } from "./env.ts";
import { claudeCode, docker, noSandbox, run, runAll } from "./index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "no-sandbox": { type: "boolean", default: false },
    image: { type: "string" },
    model: { type: "string" },
    task: { type: "string", multiple: true },
    "max-iterations": { type: "string" },
  },
});

const prompt = positionals.join(" ");
const tasks = values.task ?? [];
if (!prompt === !tasks.length) {
  console.error(
    'usage: bunker "<prompt>" [--model <id>] [--image <name>] [--no-sandbox] [--max-iterations <n>]\n' +
      '       bunker --task "<prompt>" --task "<prompt>" ...   (parallel, one worktree each)',
  );
  process.exit(2);
}

const maxIterations = values["max-iterations"] === undefined ? 1 : Number(values["max-iterations"]);
if (!Number.isInteger(maxIterations) || maxIterations < 1) {
  console.error("bunker: --max-iterations must be a positive integer");
  process.exit(2);
}

await loadBunkerEnv(process.cwd());
if (!values["no-sandbox"] && !hasAuth()) {
  // On the host claude can use your login; in a container it only has what we pass in.
  console.error(AUTH_HINT);
  process.exit(2);
}

const agent = claudeCode({ model: values.model });
const sandbox = values["no-sandbox"] ? noSandbox() : docker({ image: values.image });

if (prompt) {
  const result = await run({ prompt, agent, sandbox, maxIterations });
  console.log(`\nbunker: ${result.commits.length} commit(s) merged from ${result.branch}`);
  for (const c of result.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
} else {
  const results = await runAll({ tasks: tasks.map((p) => ({ prompt: p })), agent, sandbox, maxIterations });
  console.log();
  for (const r of results) {
    console.log(`bunker: [${r.status}] ${r.branch} (${r.commits.length} commit(s)) ${r.prompt}`);
    for (const c of r.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
    if (r.error) console.log(`  ${r.error.split("\n")[0]}`);
  }
  if (results.some((r) => r.status !== "merged")) process.exit(1);
}
