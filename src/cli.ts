#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { AUTH_HINT, hasAuth, loadBunkerEnv } from "./env.ts";
import { claudeCode, docker, noSandbox, run } from "./index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "no-sandbox": { type: "boolean", default: false },
    image: { type: "string" },
    model: { type: "string" },
  },
});

const prompt = positionals.join(" ");
if (!prompt) {
  console.error('usage: bunker "<prompt>" [--model <id>] [--image <name>] [--no-sandbox]');
  process.exit(2);
}

await loadBunkerEnv(process.cwd());
if (!values["no-sandbox"] && !hasAuth()) {
  // On the host claude can use your login; in a container it only has what we pass in.
  console.error(AUTH_HINT);
  process.exit(2);
}

const result = await run({
  prompt,
  agent: claudeCode({ model: values.model }),
  sandbox: values["no-sandbox"] ? noSandbox() : docker({ image: values.image }),
});

console.log(`\nbunker: ${result.commits.length} commit(s) merged from ${result.branch}`);
for (const c of result.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.subject}`);
