#!/usr/bin/env bun
/**
 * Mutation check of bunker's safety gates (#329): break one gate at a time, run the full suite, restore.
 * A gate whose mutation still passes the suite is unprotected by tests. Run from a clean checkout:
 *
 *   bun scripts/mutate-gates.ts [--only <name>]
 *
 * Each mutation must match its file exactly once, or it is reported as stale (the code moved).
 */
import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { only: { type: "string" } } });

const MUTATIONS: { name: string; file: string; find: string; replace: string }[] = [
  { name: "human-review paths (.bunker/.github)", file: "src/pipeline/steps/pr.ts", find: "/^\\.(bunker|github)\\//.test(f)", replace: "false" },
  { name: "human-review fails open on a diff error", file: "src/pipeline/steps/pr.ts", find: "const sensitive = diff.exitCode === 0 ?", replace: "const sensitive = true ?" },
  { name: "required check missing → still arm auto-merge", file: "src/pipeline/steps/pr.ts", find: "if (!hasRequiredCheck) return fail(", replace: "if (false) return fail(" },
  { name: "rulesets unreadable → still arm auto-merge", file: "src/pipeline/steps/pr.ts", find: "if (rules.exitCode !== 0) return fail(", replace: "if (false) return fail(" },
  { name: "git guard ignores changed hooks/config", file: "src/sandboxes/git-guard.ts", find: "if (changed.length) {", replace: "if (false) {" },
  { name: "host git keeps repo hooks", file: "src/sandboxes/git-guard.ts", find: '["core.hooksPath", "/dev/null"],', replace: "" },
  { name: "git common dir mounted writable", file: "src/sandboxes/git-guard.ts", find: "args.push(...m(gitCommonDir, true));", replace: "args.push(...m(gitCommonDir));" },
  { name: "isolated verify gets the network", file: "src/sandboxes/container.ts", find: '...(isolate ? ["--network", "none"]', replace: '...(isolate ? ["--network", "host"]' },
  { name: "isolated env keeps Claude credentials", file: "src/sandboxes/env.ts", find: "for (const name of CLAUDE_CREDENTIAL_VARS) delete env[name];", replace: "" },
  { name: "redaction skips secret values", file: "src/core/redact.ts", find: 'for (const v of values) out = out.replaceAll(v, "[REDACTED]");', replace: "" },
  { name: "label gate skips the permission check", file: "src/github/labeler.ts", find: "if (denied) return denied;", replace: "" },
  { name: "label gate allows edits after labelling", file: "src/github/labeler.ts", find: "const refuse = (): LabelerCheck => ({ ok: false,", replace: "const refuse = (): LabelerCheck => ({ ok: true," },
  { name: "every comment trusted", file: "src/github/trust.ts", find: 'c.trusted = assoc === "OWNER" ||', replace: "c.trusted = true ||" },
  { name: "prompt template from the worktree", file: "src/pipeline/steps/implement.ts", find: 'loadPromptTemplate(repo, input.fetchedSha, "issue"', replace: 'loadPromptTemplate(worktree, "HEAD", "issue"' },
];

const dirty = (await $`git status --porcelain -- src`.text()).trim();
if (dirty) {
  console.error("mutate-gates: src/ has uncommitted changes; run from a clean checkout");
  process.exit(2);
}

const rows: { name: string; result: string }[] = [];
for (const m of MUTATIONS.filter((x) => !values.only || x.name.includes(values.only))) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    rows.push({ name: m.name, result: `STALE (${hits} matches in ${m.file})` });
    continue;
  }
  writeFileSync(m.file, original.replace(m.find, m.replace));
  try {
    const t = await $`bun test`.nothrow().quiet();
    const tc = await $`bun run typecheck`.nothrow().quiet();
    const out = t.stdout.toString() + t.stderr.toString();
    const fails = /^\s*(\d+) fail$/m.exec(out)?.[1] ?? "?";
    rows.push({ name: m.name, result: t.exitCode !== 0 ? `caught (${fails} tests fail)` : tc.exitCode !== 0 ? "caught (typecheck only)" : "SURVIVED" });
  } finally {
    writeFileSync(m.file, original);
  }
  console.error(`${rows.at(-1)!.result.padEnd(24)} ${m.name}`);
}

const survived = rows.filter((r) => r.result === "SURVIVED").length;
const stale = rows.filter((r) => r.result.startsWith("STALE")).length;
console.log(`\n| Gate mutation | Result |\n|---|---|\n${rows.map((r) => `| ${r.name} | ${r.result} |`).join("\n")}`);
console.log(`\n${rows.length - survived - stale} of ${rows.length - stale} caught, ${survived} survived, ${stale} stale`);
process.exitCode = survived || stale ? 1 : 0;
