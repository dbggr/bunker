import type { Services } from "../../sandboxes/services.ts";
import { chmod } from "node:fs/promises";
import { identityKind } from "../../github/identity.ts";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { formatChecks, exec, LABELS, probeGhToken, runDoctor, userEnv, TOKEN_FIX, type Check, type RepoInfo } from "./doctor.ts";
import { addSecrets, redact } from "../../core/redact.ts";
import { PRIORITY_LABELS } from "../../core/priority.ts";
import { labelCreateArgs } from "../../github/labels.ts";
import { loadRepoConfig } from "../../core/config.ts";
import { loadSpendCaps } from "../../core/spend.ts";
import { userConfigPath } from "../../core/user-config.ts";
import { docker } from "../../sandboxes/container.ts";
import type { Sandbox } from "../../sandboxes/exec.ts";
import { atomicWrite, readText, removeTomlKey, setTomlKey } from "../init/files.ts";
import { findStep, STEPS } from "../init/guide.ts";
import { makeUi } from "../init/ui.ts";
import { combineToolchains, detectToolchains, toolchainPresets, forPackage, workspacePackages, type Toolchain } from "../init/toolchain.ts";
import { sandboxDryRun } from "../init/dry-run.ts";
import { CI_FILE, CI_JOB, createRuleset, iacTool, openCiPr, prJobNames, reportedChecks, requiredChecks, whyDenied } from "../init/merge-safety.ts";

export { detectToolchain, type Toolchain } from "../init/toolchain.ts";

type Env = Record<string, string | undefined>;

export interface Io {
  say(text: string): void;
  confirm(question: string, def?: boolean): Promise<boolean>;
  ask(question: string, def?: string): Promise<string>;
  /** Reads a value without echoing it. */
  secret(question: string): Promise<string>;
}

/** Thrown by an Io when the user hits Ctrl-C: init stops cleanly (every write is atomic, so nothing is left half-done). */
export class InitInterrupted extends Error {
  constructor() {
    super("interrupted");
  }
}

/** Sets KEY=value in an env file, creating it 0600 (and tightening an existing one). Other lines are kept. */
export async function upsertEnvVar(path: string, key: string, value: string): Promise<void> {
  const lines = (await readText(path)).split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  await atomicWrite(path, lines.join("\n") + "\n", 0o600);
}

const userEnvFile = (env: Env) => join(env.XDG_CONFIG_HOME || join(env.HOME ?? "", ".config"), "bunker", ".env");

async function ensureIgnored(root: string, env: Env, say: (t: string) => void): Promise<void> {
  const missing: string[] = [];
  for (const p of [".bunker/.env", ".bunker/runs/x"]) {
    if ((await exec(["git", "check-ignore", "-q", p], { cwd: root, env })).code !== 0) missing.push(p === ".bunker/runs/x" ? ".bunker/runs/" : p);
  }
  if (!missing.length) return;
  // .git/info/exclude is local to this clone: nothing to commit.
  const r = await exec(["git", "rev-parse", "--git-path", "info/exclude"], { cwd: root, env });
  if (r.code !== 0) return;
  const path = isAbsolute(r.out.trim()) ? r.out.trim() : join(root, r.out.trim());
  const old = await readText(path);
  await atomicWrite(path, `${old}${old && !old.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  say(`ignored ${missing.join(" and ")} (in .git/info/exclude; nothing to commit)`);
}

const looksLikeClaudeToken = (t: string) => /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(t);
const TOTAL = STEPS.length;
const PAT_URL = "https://github.com/settings/personal-access-tokens/new";
const patLink = (slug?: string) => `${PAT_URL}?name=${encodeURIComponent(`bunker${slug ? ` (${slug})` : ""}`)}&description=${encodeURIComponent("bunker: issue to reviewed PR")}&contents=write&pull_requests=write&issues=write&actions=read`;

export interface InitOptions {
  cwd: string;
  env?: Env;
  yes: boolean;
  io: Io;
  /** `--explain <step>`: print that step's guidance and stop. */
  explain?: string;
  /** Whether output goes to a terminal (colour, hyperlinks). */
  tty?: boolean;
  columns?: number;
  /** The sandbox for the verify dry run. Defaults to docker, with no credentials passed in. */
  sandbox?: Sandbox;
  /** Runs `bunker <args>` attended, for the guided first task. */
  runBunker?: (args: string[]) => Promise<number>;
}

const defaultRunBunker = async (args: string[]): Promise<number> => {
  const compiled = !process.argv[1] || process.argv[1].startsWith("/$bunfs");
  const p = Bun.spawn([process.execPath, ...(compiled ? [] : [process.argv[1]!]), ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exited;
};

export async function runInit(opts: InitOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const ui = makeUi(env, { tty: opts.tty ?? false, columns: opts.columns ?? 80 });
  const say = (t: string) => opts.io.say(ui.marks(t));
  if (opts.explain !== undefined) {
    const hit = findStep(opts.explain);
    if (!hit) {
      say(`No step "${opts.explain}". Steps: ${STEPS.map((s, i) => `${i + 1} ${s.id}`).join(", ")}`);
      return 2;
    }
    say(`${ui.header(hit.index + 1, TOTAL, hit.guide.title)}\n${ui.wrap(`Why: ${hit.guide.why}`, 2)}\n\n${hit.guide.details.map((d) => ui.wrap(d, 2)).join("\n")}`);
    return 0;
  }
  try {
    return await steps(opts, env, ui, say);
  } catch (e) {
    if (!(e instanceof InitInterrupted)) throw e;
    say("\nInterrupted. Nothing was left half-written; run `bunker init` again and it picks up where it stopped (finished steps are skipped).");
    return 130;
  }
}

async function steps(opts: InitOptions, env: Env, ui: ReturnType<typeof makeUi>, say: (t: string) => void): Promise<number> {
  const { yes } = opts;
  // --yes takes every default and never reads input
  const io: Io = yes ? { ...opts.io, confirm: async (_q, def = true) => def, ask: async (_q, def) => def ?? "" } : opts.io;
  const first = await runDoctor({ cwd: opts.cwd, env });
  const failing = (id: string) => first.checks.some((c: Check) => c.id === id && !c.ok);
  const toplevel = await exec(["git", "rev-parse", "--show-toplevel"], { cwd: opts.cwd, env });
  const root = toplevel.code === 0 ? toplevel.out.trim() : opts.cwd;
  const userFile = userEnvFile(env);
  const repo: RepoInfo | undefined = first.repo;
  const wrote: string[] = [];
  const todo: { what: string; fix: string }[] = [];
  const wrap = (t: string, indent = 2) => say(ui.wrap(t, indent));
  const skip = (what: string) => say(`  ✓ ${what} (already done, skipping)`);

  const step = (i: number) => {
    const s = STEPS[i]!;
    say(`\n${ui.header(i + 1, TOTAL, s.title)}\n${ui.progress(i + 1, TOTAL)}`);
    wrap(`Why this matters: ${s.why}`);
  };
  /** Writes a repo file after naming it; never overwrites. */
  const writeRepoFile = async (rel: string, content: string, why: string): Promise<boolean> => {
    const path = join(root, ".bunker", rel);
    if (existsSync(path)) return false;
    say(`\nProposed .bunker/${rel} (${why}):\n${content.replace(/^/gm, "    ")}`);
    if (!(await io.confirm(`Write .bunker/${rel}?`, true))) return false;
    await atomicWrite(path, content.endsWith("\n") ? content : content + "\n");
    say(`  wrote .bunker/${rel} (commit it)`);
    wrote.push(`.bunker/${rel}`);
    return true;
  };
  const store = async (key: string, value: string) => {
    addSecrets([value]);
    await upsertEnvVar(userFile, key, value);
    env[key] = value;
    say(`  saved ${key} to ${userFile} (0600)`);
    if (!wrote.includes(userFile)) wrote.push(userFile);
  };

  // 1. welcome
  step(0);
  for (const d of STEPS[0]!.details) wrap(d);
  if (!yes && !(await io.confirm("\nContinue?", true))) {
    say("Stopped. Nothing was changed.");
    return 0;
  }
  if (yes) say("\n--yes: taking every default; steps that need you are listed at the end.");

  // 2. Claude token
  step(1);
  if (failing("claude")) {
    say("  ✗ Claude Code isn't installed.");
    wrap(`Install it: ${ui.link("https://docs.claude.com/en/docs/claude-code/setup")}`, 4);
    todo.push({ what: "Claude Code (`claude`) is missing", fix: "install it (https://docs.claude.com/en/docs/claude-code/setup), then re-run `bunker init`" });
  }
  if (!failing("auth-claude")) skip("Claude credentials found");
  else if (yes) {
    say("  skipped: needs your input.");
    todo.push({ what: "Claude token", fix: "run `claude setup-token`, then re-run `bunker init` (or put ANTHROPIC_API_KEY in ~/.config/bunker/.env)" });
  } else {
    wrap("`claude setup-token` opens your browser and prints a long-lived token. Or answer n and paste a token (or API key) you already have.");
    if (!failing("claude") && (await io.confirm("Run `claude setup-token` now?", true))) await Bun.spawn(["claude", "setup-token"], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: env as Record<string, string> }).exited.catch(() => 0);
    const t = (await io.secret("Paste the token (input hidden, blank to skip): ")).trim();
    if (!t) todo.push({ what: "Claude token", fix: "run `claude setup-token`, then re-run `bunker init`" });
    else if (looksLikeClaudeToken(t) || (await io.confirm("That doesn't look like a Claude token (sk-ant-...). Save it anyway?", false))) {
      await store("CLAUDE_CODE_OAUTH_TOKEN", t);
      say("  ✓ token format looks right");
    } else todo.push({ what: "Claude token (what you pasted wasn't saved)", fix: "run `claude setup-token`, then re-run `bunker init`" });
  }

  // 3. GitHub identity
  step(2);
  if (failing("gh")) {
    say("  ✗ `gh` is missing or not logged in.");
    wrap(`Install ${ui.link("https://cli.github.com")} and run \`gh auth login\`.`, 4);
    todo.push({ what: "GitHub CLI (`gh`) not ready", fix: "install https://cli.github.com and run `gh auth login`" });
  }
  if (!failing("auth-gh")) skip("scoped GitHub token (BUNKER_GH_TOKEN) works");
  else if (yes) {
    say("  skipped: needs your input.");
    todo.push({ what: "GitHub token", fix: TOKEN_FIX });
  } else {
    say("Create a fine-grained personal access token:");
    say(
      [
        `  1. Open ${ui.link(patLink(repo?.slug), "this pre-filled link")}`,
        `     (or open ${PAT_URL} and set the permissions below by hand)`,
        `  2. Repository access: only ${repo?.slug ?? "this repository"}; pick a short expiry`,
        "  3. Permissions (nothing else):",
        "       Contents: Read and write        push the agent's branch",
        "       Pull requests: Read and write   open, update and merge the PR",
        "       Issues: Read and write          read the task, label it, comment",
        "       Metadata: Read                  added automatically",
        "       Actions: Read                   see whether CI passed",
        "       Workflows: leave at No access   an agent can never edit your CI",
      ].join("\n"),
    );
    const t = (await io.secret("Paste the token (input hidden, blank to skip): ")).trim();
    if (!t) todo.push({ what: "GitHub token", fix: TOKEN_FIX });
    else if (repo) {
      const probe = await probeGhToken(repo, first.defaultBranch ?? "HEAD", { ...env, BUNKER_GH_TOKEN: t });
      if (probe.missing.length) {
        say(`  ✗ That token can't access: ${probe.missing.join(", ")}. Not saved; fix the permissions and re-run \`bunker init\`.`);
        todo.push({ what: `GitHub token lacks ${probe.missing.join(", ")}`, fix: `edit the token's permissions at ${PAT_URL.replace("/new", "")} then re-run \`bunker init\`` });
      } else {
        await store("BUNKER_GH_TOKEN", t);
        say("  ✓ token validated against the repo (Metadata, Contents, Issues, Pull requests)");
      }
    } else {
      say("  No GitHub origin detected, so the token can't be validated. Not saved; add a GitHub origin remote and re-run `bunker init`.");
      todo.push({ what: "GitHub token not validated (no GitHub origin)", fix: "git remote add origin https://github.com/<owner>/<repo>.git, then re-run `bunker init`" });
    }
  }
  // optional: act as a GitHub App or a bot account instead of the owner's PAT
  if (!yes && identityKind(env) === "pat") {
    say("\n  Advanced, skip unless you know you need it:");
    wrap("By default bunker acts with your PAT, so PRs are authored by you. A GitHub App or a bot account gives separate attribution and lets you require your approval before merge (docs/getting-started.md).", 4);
    if (await io.confirm("Set up a separate GitHub identity?", false)) {
      const kind = (await io.ask("App or bot account? [app/bot]: ", "app")).trim().toLowerCase();
      if (kind.startsWith("b")) {
        const t = (await io.secret("Paste the bot account's fine-grained token (input hidden, blank to skip): ")).trim();
        if (t) await store("BUNKER_BOT_GH_TOKEN", t);
      } else {
        const id = (await io.ask("GitHub App ID (blank to skip): ", "")).trim();
        const key = (await io.ask("Path to the App's private key (.pem): ", "")).trim();
        if (!id || !key) say("  Skipped: the App ID and key path are both needed.");
        else if (!existsSync(key)) say(`  No file at ${key}. Not saved; re-run \`bunker init\`.`);
        else {
          await chmod(key, 0o600);
          await store("BUNKER_APP_ID", id);
          await store("BUNKER_APP_PRIVATE_KEY_PATH", key);
        }
      }
    }
  }

  if (failing("repo")) {
    say("\n  ✗ This isn't a git repository, so the per-repo steps (4 to 8) can't run.");
    todo.push({ what: "not inside a git repository", fix: "cd into your project's checkout and re-run `bunker init`" });
    return summary();
  }

  // 4. toolchain
  step(3);
  let cfg: { setup?: string; prepare?: string; verify?: string; verify_network?: boolean; copy?: string[]; services?: Services } = {};
  try {
    cfg = (await loadRepoConfig(root)).config;
  } catch {}
  const cmds: { setup?: string; verify?: string; copy?: string[] } = { setup: cfg.setup, verify: cfg.verify, copy: cfg.copy };
  for (const [name, svc] of Object.entries(cfg.services ?? {})) {
    // doctor (run above) already tried to pull each image.
    const bad = first.checks.find((c: Check) => c.id === `service-${name}`);
    if (bad && !bad.ok) {
      say(`  ✗ Service ${name} (${svc.image}): the image can't be pulled.`);
      todo.push({ what: `service image ${svc.image} can't be pulled`, fix: `check the image name and registry access: docker pull ${svc.image}` });
    } else say(`  ✓ Service ${name} (${svc.image}) started for verify; image available.`);
  }
  let tcMemo: { tc?: Toolchain } | undefined;
  /** The toolchain to base files on; asks when the repo points at several, or is a monorepo. */
  const chooseToolchain = async (): Promise<Toolchain | undefined> => {
    if (tcMemo) return tcMemo.tc;
    const found = detectToolchains(root);
    let tc = found[0];
    if (!yes) {
      const presets = toolchainPresets().map((p) => found.find((f) => f.name === p.name) ?? p);
      const detected = presets.map((p, i) => (found.some((f) => f.name === p.name) ? i + 1 : 0)).filter(Boolean);
      const custom = presets.length + 1;
      say(found.length ? "  Pick the toolchain(s) bunker sets up and verifies (detected ones are marked):" : "  Pick the toolchain(s) bunker sets up and verifies:");
      presets.forEach((p, i) => say(`    ${detected.includes(i + 1) ? "[x]" : "[ ]"} ${i + 1}) ${p.name}: setup ${p.setup}, verify ${p.verify}`));
      say(`    [ ] ${custom}) custom: type your own commands`);
      const raw = (await io.ask(`Numbers, separated by spaces (${custom} or blank for custom) `, detected.join(" "))).trim();
      const picks = new Set(raw.split(/[\s,]+/).map((w) => (/^custom$/i.test(w) ? custom : Number(w))).filter((n) => Number.isInteger(n) && n >= 1 && n <= custom));
      tc = picks.has(custom) ? undefined : combineToolchains(presets.filter((_, i) => picks.has(i + 1)));
    } else if (found.length > 1) {
      say("  This repo looks like more than one kind of project:");
      found.forEach((f, i) => say(`    ${i + 1}) ${f.name}: setup \`${f.setup}\`, verify \`${f.verify}\``));
      say(`  --yes: using the first (${tc!.name}). Edit .bunker/config.toml if that's wrong.`);
    }
    if (tc && ["bun", "pnpm", "yarn", "npm"].includes(tc.name)) {
      const pkgs = workspacePackages(root);
      if (pkgs.length) {
        say("  This looks like a monorepo. Packages:");
        pkgs.forEach((p, i) => say(`    ${i + 1}) ${p.name} (${p.dir})`));
        if (yes) say("  --yes: verifying the whole repo from the root.");
        else {
          const a = Number((await io.ask(`Which package should verify run? [1-${pkgs.length}, blank = whole repo] `, "")).trim());
          if (a >= 1 && a <= pkgs.length) tc = forPackage(root, tc, pkgs[a - 1]!);
        }
      }
    }
    tcMemo = { tc };
    return tc;
  };
  let proposedCopy: string[] | undefined;
  const needsFiles = failing("setup") || failing("verify");
  if (!needsFiles) skip(`setup and verify are set in .bunker/config.toml (verify: ${cmds.verify})`);
  else {
    const tc = await chooseToolchain();
    if (!tc) {
      if (yes) say("  Couldn't recognise the toolchain (looked for package.json, lockfiles, composer.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod).");
      else say("  Custom commands:");
      if (yes) todo.push({ what: "no setup/verify command", fix: 'add verify = "<your test command>" (and setup = "<install command>") to .bunker/config.toml' });
      else {
        const setup = (await io.ask("Setup command, run once in a fresh checkout (blank = none): ", "")).trim();
        const verify = (await io.ask("Verify command, must pass before pushing (blank = skip for now): ", "")).trim();
        if (setup) cmds.setup = setup;
        if (verify) cmds.verify = verify;
        if (!verify) todo.push({ what: "no verify command", fix: 'add verify = "<your test command>" to .bunker/config.toml; without it --merge and watch can\'t run' });
      }
    } else {
      cmds.setup ??= tc.setup;
      cmds.verify ??= tc.verify;
      say(`  ${yes ? "Detected" : "Chosen:"} ${tc.name}. Proposed commands:`);
      if (failing("setup")) say(`    setup:  ${cmds.setup}`);
      if (failing("verify")) say(`    verify: ${cmds.verify || "(none)"}`);
      if (!tc.verify && failing("verify")) todo.push({ what: "no verify command", fix: `add verify = "<your test command>" to .bunker/config.toml. ${tc.note ?? ""}`.trim() });
      if (tc.copy?.length && !cmds.copy) {
        cmds.copy = tc.copy;
        proposedCopy = tc.copy;
        say(`    copy:   ${JSON.stringify(tc.copy)} (gitignored, copied into each worktree)`);
      }
      if (tc.note) wrap(`Note: ${tc.note}`, 4);
      if (!yes && (await io.confirm("Edit these commands?", false))) {
        if (failing("setup")) cmds.setup = (await io.ask("setup: ", cmds.setup)).trim() || undefined;
        if (failing("verify")) cmds.verify = (await io.ask("verify: ", cmds.verify)).trim() || undefined;
      }
    }
    const configPath = join(root, ".bunker", "config.toml");
    const add = [failing("setup") && cmds.setup && (["setup", cmds.setup] as const), failing("verify") && cmds.verify && (["verify", cmds.verify] as const), proposedCopy && (["copy", proposedCopy] as const)].filter(Boolean) as (readonly [string, string | string[]])[];
    const comment = (k: string) => (k === "setup" ? "# runs in each worktree before the agent" : k === "copy" ? "# gitignored files copied into each worktree" : "# must pass before anything is pushed");
    if (add.length) {
      const had = existsSync(configPath);
      const proposed = add.map(([k, v]) => `${comment(k)}\n${k} = ${JSON.stringify(v)}`).join("\n\n");
      say(`\nProposed ${had ? "additions to " : ""}.bunker/config.toml:\n${proposed.replace(/^/gm, "    ")}`);
      if (await io.confirm(`${had ? "Add to" : "Write"} .bunker/config.toml?`, true)) {
        let text = await readText(configPath);
        if (!had) text = add.map(([k, v]) => `${comment(k)}\n${k} = ${JSON.stringify(v)}`).join("\n\n") + "\n";
        else for (const [k, v] of add) text = setTomlKey(text, k, v);
        await atomicWrite(configPath, text);
        say(`  wrote .bunker/config.toml (commit it)`);
        wrap(`Customise later by editing setup and verify in .bunker/config.toml. Written: ${add.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}`, 4);
        wrote.push(".bunker/config.toml");
      } else todo.push({ what: "setup/verify not written", fix: `add ${add.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(" and ")} to .bunker/config.toml` });
    }
  }
  if (!cmds.verify) say("  Without a verify command in .bunker/config.toml, --merge and watch can't run.");

  // 5. sandbox image and verify dry run
  step(4);
  const dockerOk = !failing("docker");
  if (!dockerOk) {
    say("  ✗ Docker isn't reachable.");
    wrap(`Install Docker (${ui.link("https://docs.docker.com/get-docker/")}) or Podman and start the daemon.`, 4);
    todo.push({ what: "Docker not reachable, so the sandbox wasn't tested", fix: "install/start Docker (https://docs.docker.com/get-docker/), then re-run `bunker init`" });
  }
  if (failing("dockerfile")) {
    const tc = await chooseToolchain();
    if (tc) await writeRepoFile("Dockerfile", `FROM bunker-claude\n${tc.dockerfile}`, `adds ${tc.name}, which the base image lacks`);
    else say("  No .bunker/Dockerfile: the sandbox is the base image only (no node, python, ... ). Add one if your tests need a runtime.");
  } else skip(".bunker/Dockerfile exists");
  if (dockerOk && cmds.verify) {
    const sandbox = opts.sandbox ?? docker({ env: [] });
    let attempt = 0;
    let regenerated = false;
    for (;;) {
      attempt++;
      if (!yes && attempt === 1 && !(await io.confirm("Build the sandbox image and run setup and verify once inside it now? (a few minutes the first time)", true))) {
        todo.push({ what: "sandbox not tested", fix: "run `bunker issue <n> --verify ...` or re-run `bunker init` before the first unattended run" });
        break;
      }
      say(`  Building the image and running ${cmds.setup ? "setup, then " : ""}verify (isolated, no network)...`);
      const r = await sandboxDryRun({ root, env, sandbox, ...(cmds.setup ? { setup: cmds.setup } : {}), verify: cmds.verify, network: cfg.verify_network === true, ...(cfg.services && Object.keys(cfg.services).length ? { services: cfg.services } : {}), ...(cfg.prepare?.trim() ? { prepare: cfg.prepare.trim() } : {}), ...(cmds.copy?.length ? { copy: cmds.copy } : {}) });
      if (r.ok) {
        say(`  ✓ setup and verify pass in the sandbox (${r.seconds}s)${r.tail ? `\n${r.tail.replace(/^/gm, "    | ")}` : ""}`);
        break;
      }
      say(`  ✗ ${r.phase === "image" ? "the sandbox image failed" : `${r.phase} failed`} in the sandbox. Last lines:\n${r.tail.replace(/^/gm, "    | ")}`);
      if (yes || attempt >= 5) {
        todo.push({ what: `${r.phase} fails in the sandbox`, fix: "fix the commands in .bunker/config.toml or add what's missing to .bunker/Dockerfile (e.g. `RUN apt-get install -y make`), then re-run `bunker init`" });
        break;
      }
      if (r.phase !== "image" && !regenerated && (!failing("setup") || !failing("verify"))) {
        // setup/verify came from the config of an earlier run, so init never proposed them this time.
        regenerated = true;
        const tc = await chooseToolchain();
        if (tc?.verify && (tc.setup !== cmds.setup || tc.verify !== cmds.verify) && (await io.confirm(`Replace them with the detected ${tc.name} defaults (setup: ${tc.setup || "none"}, verify: ${tc.verify})?`, true))) {
          cmds.setup = tc.setup || undefined;
          cmds.verify = tc.verify;
          const configPath = join(root, ".bunker", "config.toml");
          let text = await readText(configPath);
          text = cmds.setup ? setTomlKey(text, "setup", cmds.setup) : removeTomlKey(text, "setup");
          await atomicWrite(configPath, setTomlKey(text, "verify", cmds.verify));
          say("  updated .bunker/config.toml");
          if (!wrote.includes(".bunker/config.toml")) wrote.push(".bunker/config.toml");
          continue;
        }
      }
      if (r.phase !== "image" && (await io.confirm("Edit the commands and retry?", true))) {
        const setup = (await io.ask("setup: ", cmds.setup ?? "")).trim();
        const verify = (await io.ask("verify: ", cmds.verify)).trim();
        cmds.setup = setup || undefined;
        cmds.verify = verify || cmds.verify;
        const configPath = join(root, ".bunker", "config.toml");
        if (existsSync(configPath) && (await io.confirm("Save them to .bunker/config.toml?", true))) {
          let text = await readText(configPath);
          if (cmds.setup) text = setTomlKey(text, "setup", cmds.setup);
          text = setTomlKey(text, "verify", cmds.verify);
          await atomicWrite(configPath, text);
          say("  updated .bunker/config.toml");
          if (!wrote.includes(".bunker/config.toml")) wrote.push(".bunker/config.toml");
        }
        continue;
      }
      const dockerfile = join(root, ".bunker", "Dockerfile");
      if (existsSync(dockerfile) || (await io.confirm("Create .bunker/Dockerfile to add what's missing?", false))) {
        const line = (await io.ask("A Dockerfile line to add (e.g. RUN apt-get update && apt-get install -y make; blank = none): ", "")).trim();
        if (line) {
          const old = (await readText(dockerfile)) || "FROM bunker-claude\n";
          await atomicWrite(dockerfile, `${old.replace(/\n*$/, "\n")}${line}\n`);
          say("  updated .bunker/Dockerfile (commit it)");
          if (!wrote.includes(".bunker/Dockerfile")) wrote.push(".bunker/Dockerfile");
          continue;
        }
      }
      todo.push({ what: `${r.phase} fails in the sandbox`, fix: "fix the commands in .bunker/config.toml or the Dockerfile, then re-run `bunker init`" });
      break;
    }
  } else if (!cmds.verify) say("  Skipped: there's no verify command to try yet.");
  await ensureIgnored(root, env, (t) => wrap(t));

  // 6. merge safety
  step(5);
  wrap("That takes three things: auto-merge allowed on the repo, a CI workflow (bunker init writes one with a job named `test` if you have none), and a ruleset (GitHub's newer branch protection) that requires it. Classic branch protection (Settings -> Branches) doesn't count: bunker's scoped token can't read it.");
  const slug = repo?.slug;
  const branch = first.defaultBranch ?? "main";
  const iac = iacTool(root);
  if (iac) wrap(`This repo's settings look managed by IaC: ${iac}. Change the settings there; a UI or API edit would be reverted.`, 2);
  const settingsUrl = (path: string) => `https://github.com/${slug}/settings${path}`;
  if (!slug) say("  No GitHub origin, so there's nothing to set up here yet.");
  else {
    if (!failing("auto-merge")) skip("auto-merge is allowed");
    else {
      say("  ✗ auto-merge isn't allowed on the repo.");
      let fixed = false;
      if (!yes && !iac && (await io.confirm(`Enable "Allow auto-merge" on ${slug} (with your own gh login)?`, true))) {
        const r = await exec(["gh", "api", `repos/${slug}`, "--method", "PATCH", "-F", "allow_auto_merge=true"], { env: userEnv(env) });
        fixed = r.code === 0;
        say(fixed ? "  ✓ auto-merge enabled" : `  Could not enable it: ${whyDenied(r)}`);
      }
      if (!fixed) {
        wrap(`Settings -> General -> Pull Requests -> "Allow auto-merge": ${ui.link(settingsUrl(""))}. If the repo is managed by IaC (terraform, probot settings, ...), change it there.`, 4);
        todo.push({ what: "auto-merge not allowed", fix: `tick "Allow auto-merge" at ${settingsUrl("")}` });
      }
    }
    if (!failing("ci")) skip("a CI workflow exists");
    else {
      say("  ✗ no CI workflow found under .github/workflows/.");
      const tc = await chooseToolchain();
      let opened = false;
      if (!yes && tc && (await io.confirm(`Add ${CI_FILE} (job \`${CI_JOB}\`: ${cmds.setup ? `${cmds.setup}; ` : ""}${cmds.verify ?? tc.verify}) on a new branch and open a PR?`, true))) {
        const r = await openCiPr({ root, slug, base: branch, tc: { ...tc, setup: cmds.setup ?? tc.setup, verify: cmds.verify ?? tc.verify }, env });
        if (r.url) {
          opened = true;
          say(`  ✓ opened ${r.url} (branch ${r.branch}); not merged: review it, and merge once its \`${CI_JOB}\` job is green`);
          wrote.push(`PR ${r.url} adding ${CI_FILE}`);
          todo.push({ what: "CI workflow PR not merged yet", fix: `review and merge ${r.url}, then \`git pull\`` });
        } else say(`  ✗ Could not open the PR: ${r.error}`);
      }
      if (!opened && !todo.some((t) => t.what.startsWith("CI workflow"))) {
        wrap(`Add ${CI_FILE} with a job named \`${CI_JOB}\` that runs your tests, e.g. on pull_request (https://docs.github.com/actions/quickstart).`, 4);
        todo.push({ what: "no CI workflow", fix: `add ${CI_FILE} with a job named \`${CI_JOB}\` (bunker init offers to write it; https://docs.github.com/actions/quickstart)` });
      }
    }
    if (!failing("required-check")) skip(`${branch} requires a status check (ruleset)`);
    else {
      const already = await requiredChecks(slug, branch, env);
      const list = (cs: string[]) => cs.map((c) => `\`${c}\``).join(", ");
      // an existing CI workflow keeps its own job names; `test` is only the job bunker init writes itself
      const ownCi = !failing("ci");
      const jobs = ownCi ? prJobNames(root) : [];
      const checks = ownCi ? jobs : [CI_JOB];
      if (already.length) {
        say(`  ✓ ${branch} already requires ${list(already)} (branch protection or a ruleset); adding no ruleset.`);
        wrap("bunker --merge reads rulesets only: if it reports no required check, recreate that rule as a ruleset (Settings -> Rules) rather than adding a second check.", 4);
      } else if (!checks.length) {
        say(`  ✗ ${branch} has no ruleset requiring a status check, and none of the CI jobs that run on pull_request could be identified.`);
        wrap(`By hand: ${ui.link(settingsUrl("/rules"))} -> New ruleset -> target ${branch} -> "Require status checks to pass" -> add your CI job's name -> Create.`, 4);
        todo.push({ what: `no ruleset requiring a check on ${branch}`, fix: `create one at ${settingsUrl("/rules")} requiring your CI job (no pull_request job found in .github/workflows/)${iac ? `; settings are managed by ${iac}, so change it there` : ""}` });
      } else {
        say(`  ✗ ${branch} has no ruleset requiring a status check.`);
        let made = false;
        let unreported: string[] = [];
        if (ownCi) {
          const seen = await reportedChecks(slug, branch, env);
          unreported = checks.filter((c) => !seen.has(c));
        }
        if (unreported.length) {
          say(`  ✗ ${list(unreported)} hasn't reported on a recent ${branch} commit, so requiring it could block every PR forever. Not creating a ruleset.`);
        } else if (!yes && !iac && (await io.confirm(`Create a ruleset on ${slug} requiring ${list(checks)} on ${branch} (with your own gh login)?`, true))) {
          const r = await createRuleset(slug, env, checks);
          made = r.code === 0;
          if (made) {
            say(`  ✓ ruleset created: ${branch} now requires ${list(checks)}`);
            wrote.push(`ruleset on ${slug} requiring ${list(checks)}`);
          } else say(`  Could not create it: ${whyDenied(r)}${/rules|managed|403/i.test(r.err) ? "; if the repo is IaC-managed (terraform, probot settings), change it there" : ""}`);
        }
        if (!made) {
          wrap(`By hand: ${ui.link(settingsUrl("/rules"))} -> New ruleset -> New branch ruleset -> target ${branch} -> tick "Require status checks to pass" -> add ${list(unreported.length ? unreported : checks)} -> Create. (Settings -> Branches is classic protection and does not count.)`, 4);
          todo.push({ what: `no ruleset requiring a check on ${branch}`, fix: `create one at ${settingsUrl("/rules")} requiring ${list(checks)}${unreported.length ? " once it has run on a PR or push" : ""}${iac ? `; settings are managed by ${iac}, so change it there` : ""}` });
        }
      }
    }
  }

  // 7. spend and models
  step(6);
  const caps = await loadSpendCaps(env).catch(() => ({}) as { day?: number; month?: number });
  const repoWatch = (await loadRepoConfig(root).then((c) => c.config.watch).catch(() => ({}) as { max_cost_day?: number; max_cost_month?: number }));
  const hasDay = caps.day !== undefined || repoWatch.max_cost_day !== undefined;
  if (hasDay) skip("a daily spend cap is set");
  else {
    const cfgFile = userConfigPath(env);
    const num = (s: string) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : undefined);
    const day = yes ? 20 : num((await io.ask("Daily spend cap in USD (default: 20): ", "20")).trim()) ?? 20;
    const monthRaw = yes ? "" : (await io.ask("Monthly cap in USD (blank = none): ", "")).trim();
    const month = monthRaw ? num(monthRaw) : undefined;
    if (monthRaw && month === undefined) say(`  "${monthRaw}" isn't a positive number; no monthly cap.`);
    if (yes || (await io.confirm(`Save max_cost_day = ${day}${month ? ` and max_cost_month = ${month}` : ""} to ${cfgFile}?`, true))) {
      let text = setTomlKey(await readText(cfgFile), "max_cost_day", day);
      if (month) text = setTomlKey(text, "max_cost_month", month);
      await atomicWrite(cfgFile, text);
      say(`  saved to ${cfgFile}${yes ? " (default)" : ""}`);
      wrote.push(cfgFile);
    }
  }
  const noModel = !env.BUNKER_MODEL && !env.BUNKER_IMPLEMENTER_MODEL && !env.BUNKER_REVIEWER_MODEL;
  if (!noModel) skip("models are set");
  else if (yes) say("  Models: using Claude's default for every role (set BUNKER_MODEL in ~/.config/bunker/.env to change).");
  else {
    wrap("Models: opus is the strongest and costliest, sonnet is balanced and cheaper, haiku is cheapest and suits simple tasks. A common split: sonnet to write, opus to review.", 2);
    const model = (await io.ask("Default model for every role (blank = Claude default): ", "")).trim();
    const reviewer = (await io.ask("Reviewer model (blank = same as default): ", "")).trim();
    if (model || reviewer) {
      const where = (await io.ask("Save to the repo's .bunker/.env (gitignored) or your user file? [repo/user]: ", "user")).trim();
      const file = where.startsWith("r") ? join(root, ".bunker", ".env") : userFile;
      if (model) await upsertEnvVar(file, "BUNKER_MODEL", model);
      if (reviewer) await upsertEnvVar(file, "BUNKER_REVIEWER_MODEL", reviewer);
      say(`  saved models to ${file}`);
      wrote.push(file);
    }
  }

  // 8. labels, then the first task
  step(7);
  const missingLabels = LABELS.filter((l) => failing(`label-${l}`));
  if (!repo) say("  No GitHub origin: labels can't be created yet.");
  else if (!missingLabels.length) skip("all labels exist");
  else if (await io.confirm(`Create the missing labels (${missingLabels.join(", ")}) with gh label create?`, true)) {
    for (const l of missingLabels) {
      const pri = PRIORITY_LABELS.find((p) => p.name === l);
      const r = await exec(["gh", "label", "create", l, "--repo", repo.slug, ...(labelCreateArgs(l).length ? labelCreateArgs(l) : ["--description", `bunker: ${l}`]), ...(pri ? ["--color", pri.color] : [])], { env: userEnv(env) });
      say(r.code === 0 ? `  created label ${l}` : `  could not create ${l}: ${redact(r.err.trim())}`);
      if (r.code === 0) wrote.push(`label ${l}`);
    }
  } else todo.push({ what: "labels not created", fix: `run \`gh label create <name> --repo ${repo.slug}\` for: ${missingLabels.join(", ")}` });

  const oldLabels = first.checks.filter((c) => c.id.startsWith("old-label-") && !c.ok);
  if (oldLabels.length) {
    say("\n  Old labels (no longer used; rename them to keep them on existing issues and PRs):");
    for (const c of oldLabels) say(`    ${c.fix}`);
  }

  // final doctor
  say("\n== Doctor ==");
  const last = await runDoctor({ cwd: opts.cwd, env });
  say(formatChecks(last.checks));

  if (last.code === 0 && !yes && repo) {
    say("\n== First task ==");
    wrap("Everything required is ✓. Want to watch bunker do one real loop? It creates a tiny 'hello bunker' issue, then runs it attended without auto-merge: you see the agent work and review the PR yourself before anything merges.");
    if (await io.confirm(`Create a 'hello bunker' issue on ${repo.slug} and run it now?`, true)) {
      const body = "Add a short `HELLO_BUNKER.md` at the repo root saying that this file was written by bunker as a first test, and nothing else. Created by `bunker init`; safe to close.";
      const r = await exec(["gh", "issue", "create", "--repo", repo.slug, "--title", "hello bunker: add HELLO_BUNKER.md", "--body", body], { env: userEnv(env) });
      const n = /\/issues\/(\d+)/.exec(r.out)?.[1];
      if (r.code !== 0 || !n) say(`  Could not create the issue: ${redact(r.err.trim())}. Create one yourself and run \`bunker issue <n>\`.`);
      else {
        wrote.push(`issue #${n} (hello bunker)`);
        say(`  created ${r.out.trim()}; running \`bunker issue ${n}\` (Ctrl-C stops it)...`);
        const code = await (opts.runBunker ?? defaultRunBunker)(["issue", n]);
        say(code === 0 ? "  Done. Review the PR it opened and merge it yourself if you like it." : `  bunker exited ${code}; see the output above, and \`bunker doctor\`.`);
      }
    }
  }
  return summary(last);

  function summary(final?: Awaited<ReturnType<typeof runDoctor>>): number {
    say("\n== Summary ==");
    if (wrote.length) say(`Written or created:\n${wrote.map((w) => `  ✓ ${w}`).join("\n")}`);
    else say("Nothing was written or created this time.");
    const open = (final?.checks ?? []).filter((c) => c.required && !c.ok);
    const listed = todo.map((t) => `  ✗ ${t.what}\n${ui.wrap(t.fix, 6)}`);
    for (const c of open) if (!todo.some((t) => t.what.toLowerCase().includes(c.label.toLowerCase().slice(0, 12)))) listed.push(`  ✗ ${c.label}${c.detail ? `: ${c.detail}` : ""}${c.fix ? `\n${ui.wrap(c.fix, 6)}` : ""}`);
    if (listed.length) say(`Still to do:\n${listed.join("\n")}`);
    const code = final ? final.code : 1;
    if (code === 0) say("\nAll set. Start with:\n  bunker issue <n> --merge\nor work the labelled queue unattended:\n  bunker watch");
    else wrap("\nNext: fix the ✗ items above, then run `bunker init` again (it skips what's done) or `bunker doctor` to check.", 0);
    return code;
  }
}

/** Terminal Io: line input from stdin, secrets read without echo. Ctrl-C throws InitInterrupted. */
export function terminalIo(): Io {
  const lines = (async function* () {
    for await (const l of console) yield l;
  })();
  const tty = !!process.stdin.isTTY;
  const readLine = async (echo: boolean): Promise<string> => {
    if (!tty) return (await lines.next()).value ?? "";
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      let buf = "";
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write("\n");
            return resolve(buf);
          }
          if (ch === "\x03") {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write("\n");
            return reject(new InitInterrupted());
          }
          if (ch === "\x7f" || ch === "\b") {
            if (buf.length && echo) process.stdout.write("\b \b");
            buf = buf.slice(0, -1);
          } else if (ch >= " ") {
            buf += ch;
            if (echo) process.stdout.write(ch);
          }
        }
      };
      stdin.on("data", onData);
    });
  };
  return {
    say: (t) => console.log(t),
    confirm: async (q, def = true) => {
      process.stdout.write(`${q} [${def ? "Y/n" : "y/N"}] `);
      const a = (await readLine(true)).trim().toLowerCase();
      return a === "" ? def : a.startsWith("y");
    },
    ask: async (q, def) => {
      process.stdout.write(def ? `${q.replace(/:?\s*$/, "")} (default: ${def}): ` : q);
      const a = await readLine(true);
      return a === "" ? (def ?? "") : a;
    },
    secret: async (q) => {
      process.stdout.write(q);
      return readLine(false);
    },
  };
}
