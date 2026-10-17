import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdleTimeout, agentLimits, runSetup, sumUsage, timeoutMessage, type Timeouts, type Agent, type Sandbox, type Usage } from "./index.ts";
import { auditOutput, extractOutput } from "./structured.ts";

export interface AuditOptions extends Timeouts {
  agent: Agent;
  sandbox: Sandbox;
  /** The target repo's main checkout. Defaults to process.cwd(). */
  cwd?: string;
  /** Max issues to file. Defaults to 5. */
  maxIssues?: number;
  /** Steer the audit towards an area or theme. */
  focus?: string;
  /** Shell command run in the worktree, inside `sandbox`, before the agent. Defaults to the repo's `.bunker/setup` script if present. */
  setup?: string;
  /** Times to re-ask the agent for a missing or invalid `<audit>` block. Defaults to 2. */
  maxRetries?: number;
}

export interface AuditResult {
  /** Issues filed (label `discovered`). */
  filed: { number: number; title: string }[];
  /** Titles dropped because an open issue already has that title. */
  skipped: string[];
  /** What the audit agent cost, when it reported usage. */
  usage?: Usage;
}

const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

const AUDIT_FORMAT =
  'End your answer with <audit>{"issues": [{"title": "short title", "body": "body with acceptance criteria as a checklist"}]}</audit>: ' +
  "valid JSON (escape quotes and newlines in strings), with an empty array if there is nothing to report. Only the last <audit> in your answer counts.";

export function auditPrompt(maxIssues: number, focus?: string): string {
  return (
    "Audit this repository. Read the code, tests and docs, and find the most valuable concrete improvements: " +
    "bugs, missing tests, gaps against the docs, risky behaviour, or missing features. Do not change any files or commit.\n\n" +
    (focus ? `Focus on: ${focus}\n\n` : "") +
    `Report at most ${maxIssues} improvements, most valuable first. ${AUDIT_FORMAT} ` +
    "Each must be specific and actionable on its own."
  );
}

/**
 * One read-only agent over a fresh worktree of origin's default branch; whatever
 * issues in its final `<audit>` JSON block (re-asked when invalid) are filed as `discovered` (never `bunker`), minus
 * titles that match an open issue. The worktree is always removed.
 */
export async function runAudit({ agent, sandbox, cwd = process.cwd(), maxIssues = 5, focus, setup, maxRetries = 2, ...timeouts }: AuditOptions): Promise<AuditResult> {
  const token = process.env.BUNKER_GH_TOKEN;
  const env = (token ? { ...process.env, GH_TOKEN: token } : process.env) as Record<string, string>;
  const gitCfg = token ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
  const repo = (await $`git -C ${cwd} rev-parse --show-toplevel`.text()).trim();
  const gitCommonDir = (await $`git -C ${repo} rev-parse --path-format=absolute --git-common-dir`.text()).trim();

  let remote = "origin";
  if (token) {
    const url = (await $`git -C ${repo} remote get-url origin`.nothrow().quiet().text()).trim();
    const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url);
    if (m) remote = `https://github.com/${m[1]}.git`;
  }
  const head = await $`git ${gitCfg} -C ${repo} ls-remote --symref ${remote} HEAD`.env(env).nothrow().quiet();
  const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head.stdout.toString())?.[1] ?? "main";
  // A private ref, not FETCH_HEAD: other bunker processes share the repo and their fetches rewrite FETCH_HEAD.
  const ref = `refs/bunker/fetch/audit-${crypto.randomUUID()}`;
  const fetch = await $`git ${gitCfg} -C ${repo} fetch -q --no-write-fetch-head ${remote} ${`+refs/heads/${defaultBranch}:${ref}`}`.env(env).nothrow().quiet();
  if (fetch.exitCode !== 0) throw new Error(`could not fetch origin/${defaultBranch}:\n${fetch.stderr}`);
  const baseSha = (await $`git -C ${repo} rev-parse ${ref}`.text()).trim();
  await $`git -C ${repo} update-ref -d ${ref}`.nothrow().quiet();

  const open = await $`gh issue list --state open --limit 1000 --json number,title`.cwd(repo).env(env).nothrow().quiet();
  if (open.exitCode !== 0) throw new Error(`gh issue list failed:\n${open.stderr}`);
  const existing = new Set((JSON.parse(open.stdout.toString()) as { title: string }[]).map((i) => norm(i.title)));

  const worktree = join(tmpdir(), `bunker-audit-${crypto.randomUUID().slice(0, 8)}`);
  const add = await $`git -C ${repo} worktree add -q --detach ${worktree} ${baseSha}`.nothrow().quiet();
  if (add.exitCode !== 0) throw new Error(`could not create worktree:\n${add.stderr}`);

  let issues: { title: string; body: string }[];
  let usage: Usage | undefined;
  try {
    const ctx = { worktree, gitCommonDir };
    const prep = await runSetup(sandbox, ctx, setup, timeouts);
    if (prep?.timedOut) throw new IdleTimeout(timeoutMessage("setup", prep.timedOut, timeouts));
    if (prep && prep.code !== 0) throw new Error(`setup failed (exit ${prep.code}):\n${prep.stdout.slice(-2000)}`);
    const base = auditPrompt(maxIssues, focus);
    const usages: (Usage | undefined)[] = [];
    let prompt = base;
    for (let k = 0; ; k++) {
      const res = await sandbox.exec(agent.command(prompt, "review"), { ...ctx, limits: agentLimits(timeouts, ["</audit>"]) });
      if (res.timedOut) throw new IdleTimeout(timeoutMessage("audit agent", res.timedOut, timeouts));
      if (res.code !== 0) throw new Error(`agent exited with ${res.code}`);
      const parsed = agent.parse?.(res.stdout);
      usages.push(parsed?.usage);
      const found = extractOutput(parsed?.text ?? res.stdout, auditOutput);
      if (found.ok) {
        issues = found.value.issues;
        break;
      }
      if (k >= maxRetries) throw new Error(`audit agent gave bad output after ${maxRetries} retries: ${found.error}`);
      prompt = `${base}\n\nYour previous answer had no usable audit (${found.error}). Answer again. ${AUDIT_FORMAT}`;
    }
    usage = sumUsage(usages);
  } finally {
    await $`git -C ${repo} worktree remove --force ${worktree}`.nothrow().quiet();
  }

  const result: AuditResult = { filed: [], skipped: [], ...(usage ? { usage } : {}) };
  const fresh: { title: string; body: string }[] = [];
  for (const b of issues) {
    if (existing.has(norm(b.title))) result.skipped.push(b.title);
    else fresh.push(b);
  }
  for (const b of fresh.slice(0, maxIssues)) {
    const body = `${b.body}\n\nFiled by \`bunker --audit\`.`;
    const created = await $`gh issue create --label discovered --title ${b.title} --body ${body}`.cwd(repo).env(env).nothrow().quiet();
    if (created.exitCode !== 0) {
      console.error(`bunker: gh issue create failed for "${b.title}":\n${created.stderr}`);
      continue;
    }
    const n = Number(/\/issues\/(\d+)/.exec(created.stdout.toString())?.[1]);
    result.filed.push({ number: Number.isInteger(n) ? n : 0, title: b.title });
  }
  return result;
}
