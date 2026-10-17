import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { formatChecks, exec, LABELS, probeGhToken, runDoctor, userEnv, TOKEN_FIX, type Check, type RepoInfo } from "./doctor.ts";
import { addSecrets, redact } from "./redact.ts";
import { PRIORITY_LABELS } from "./priority.ts";

type Env = Record<string, string | undefined>;

export interface Io {
  say(text: string): void;
  confirm(question: string, def?: boolean): Promise<boolean>;
  ask(question: string, def?: string): Promise<string>;
  /** Reads a value without echoing it. */
  secret(question: string): Promise<string>;
}

export interface Toolchain {
  name: string;
  setup: string;
  verify: string;
  /** Dockerfile lines after `FROM bunker-claude`: the runtime the base image lacks. */
  dockerfile: string;
}

const NODE_RUNTIME = "COPY --from=node:22-slim /usr/local/ /usr/local/";

/** Guesses the repo's toolchain from its lockfiles / manifests. */
export async function detectToolchain(root: string): Promise<Toolchain | undefined> {
  const has = (f: string) => existsSync(join(root, f));
  if (has("bun.lock") || has("bun.lockb"))
    return {
      name: "bun",
      setup: "bun install --frozen-lockfile",
      verify: "bun test && bun run typecheck",
      dockerfile: "COPY --from=oven/bun:1-slim /usr/local/bin/bun /usr/local/bin/bun\nRUN ln -s /usr/local/bin/bun /usr/local/bin/bunx",
    };
  if (has("pnpm-lock.yaml"))
    return { name: "pnpm", setup: "pnpm install --frozen-lockfile", verify: "pnpm test", dockerfile: `${NODE_RUNTIME}\nRUN corepack enable` };
  if (has("yarn.lock")) return { name: "yarn", setup: "yarn install --frozen-lockfile", verify: "yarn test", dockerfile: `${NODE_RUNTIME}\nRUN corepack enable` };
  if (has("package-lock.json")) return { name: "npm", setup: "npm ci", verify: "npm test", dockerfile: NODE_RUNTIME };
  if (has("composer.json"))
    return {
      name: "php",
      setup: "composer install --no-interaction",
      verify: "composer test",
      dockerfile: "RUN apt-get update && apt-get install -y --no-install-recommends php-cli php-xml php-mbstring unzip && rm -rf /var/lib/apt/lists/*\nCOPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer",
    };
  if (has("pyproject.toml") || has("requirements.txt"))
    return {
      name: "python",
      setup: has("pyproject.toml") ? "pip install -e ." : "pip install -r requirements.txt",
      verify: "pytest",
      dockerfile: "RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*",
    };
  if (has("Cargo.toml"))
    return { name: "rust", setup: "cargo fetch", verify: "cargo test", dockerfile: "RUN apt-get update && apt-get install -y --no-install-recommends cargo && rm -rf /var/lib/apt/lists/*" };
  if (has("go.mod"))
    return { name: "go", setup: "go mod download", verify: "go test ./...", dockerfile: "COPY --from=golang:1.23 /usr/local/go /usr/local/go\nENV PATH=/usr/local/go/bin:$PATH" };
  return undefined;
}

/** Sets KEY=value in an env file, creating it 0600 (and tightening an existing one). Other lines are kept. */
export async function upsertEnvVar(path: string, key: string, value: string): Promise<void> {
  const file = Bun.file(path);
  const lines = (await file.exists()) ? (await file.text()).split("\n").filter((l, i, a) => l !== "" || i < a.length - 1) : [];
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, lines.join("\n") + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

const userEnvFile = (env: Env) => join(env.XDG_CONFIG_HOME || join(env.HOME ?? "", ".config"), "bunker", ".env");

async function ensureIgnored(root: string, env: Env, io: Io): Promise<void> {
  const missing: string[] = [];
  for (const p of [".bunker/.env", ".bunker/runs/x"]) {
    if ((await exec(["git", "check-ignore", "-q", p], { cwd: root, env })).code !== 0) missing.push(p === ".bunker/runs/x" ? ".bunker/runs/" : p);
  }
  if (!missing.length) return;
  // .git/info/exclude is local to this clone: nothing to commit.
  const r = await exec(["git", "rev-parse", "--git-path", "info/exclude"], { cwd: root, env });
  if (r.code !== 0) return;
  const path = isAbsolute(r.out.trim()) ? r.out.trim() : join(root, r.out.trim());
  const file = Bun.file(path);
  const old = (await file.exists()) ? await file.text() : "";
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${old}${old && !old.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  io.say(`ignored ${missing.join(" and ")} (in .git/info/exclude; nothing to commit)`);
}

export async function runInit(opts: { cwd: string; env?: Env; yes: boolean; io: Io }): Promise<number> {
  const env = opts.env ?? process.env;
  const { io, yes } = opts;
  const first = await runDoctor({ cwd: opts.cwd, env });
  io.say(formatChecks(first.checks));
  const failing = (id: string) => first.checks.some((c: Check) => c.id === id && !c.ok);
  const toplevel = await exec(["git", "rev-parse", "--show-toplevel"], { cwd: opts.cwd, env });
  const root = toplevel.code === 0 ? toplevel.out.trim() : opts.cwd;
  const userFile = userEnvFile(env);
  const repo: RepoInfo | undefined = first.repo;

  const store = async (key: string, value: string) => {
    addSecrets([value]);
    await upsertEnvVar(userFile, key, value);
    env[key] = value;
    io.say(`saved ${key} to ${userFile} (0600)`);
  };

  // user auth
  if (failing("auth-claude")) {
    io.say("\n== Claude auth ==");
    if (yes) io.say("skipped: needs your input. Run `claude setup-token`, then re-run `bunker init`.");
    else {
      if (await io.confirm("Run `claude setup-token` now?", true)) await Bun.spawn(["claude", "setup-token"], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: env as Record<string, string> }).exited.catch(() => 0);
      const t = (await io.secret("Paste the token (input hidden, blank to skip): ")).trim();
      if (t) await store("CLAUDE_CODE_OAUTH_TOKEN", t);
    }
  }
  const ghFailing = first.checks.find((c) => c.id === "auth-gh" && !c.ok);
  if (ghFailing) {
    io.say("\n== GitHub token ==");
    if (yes) io.say(`skipped: needs your input. ${TOKEN_FIX}`);
    else {
      io.say(
        [
          "Create a fine-grained personal access token at https://github.com/settings/personal-access-tokens/new",
          `  Repository access: only ${repo?.slug ?? "this repository"}; pick a short expiry`,
          "  Permissions (nothing else):",
          "    - Contents: Read and write",
          "    - Pull requests: Read and write",
          "    - Issues: Read and write",
          "    - Metadata: Read (added automatically)",
        ].join("\n"),
      );
      const t = (await io.secret("Paste the token (input hidden, blank to skip): ")).trim();
      if (t && repo) {
        const probe = await probeGhToken(repo, first.defaultBranch ?? "HEAD", { ...env, BUNKER_GH_TOKEN: t });
        if (probe.missing.length) io.say(`That token can't access: ${probe.missing.join(", ")}. Not saved; fix the permissions and re-run \`bunker init\`.`);
        else await store("BUNKER_GH_TOKEN", t);
      } else if (t) io.say("No GitHub origin detected, so the token can't be validated. Not saved; add a GitHub origin remote and re-run `bunker init`.");
    }
  }

  // repo files
  if (!first.checks.some((c) => c.id === "repo" && !c.ok)) {
    const tc = await detectToolchain(root);
    const writeFileAsk = async (rel: string, content: string, why: string) => {
      const path = join(root, ".bunker", rel);
      if (existsSync(path)) return;
      io.say(`\nProposed .bunker/${rel} (${why}):\n${content.replace(/^/gm, "  ")}`);
      if (!(await io.confirm(`Write .bunker/${rel}?`, true))) return;
      await mkdir(join(root, ".bunker"), { recursive: true });
      await Bun.write(path, content.endsWith("\n") ? content : content + "\n");
      io.say(`wrote .bunker/${rel} (commit it)`);
    };
    io.say("\n== Repo files ==");
    if (!tc) io.say("Could not detect the toolchain: write .bunker/setup and .bunker/verify yourself.");
    else {
      const toml = [failing("setup") && `# runs in each worktree before the agent\nsetup = ${JSON.stringify(tc.setup)}`, failing("verify") && `# must pass before anything is pushed\nverify = ${JSON.stringify(tc.verify)}`].filter(Boolean).join("\n\n");
      if (toml && existsSync(join(root, ".bunker", "config.toml"))) io.say(`.bunker/config.toml exists and lacks ${[failing("setup") && "setup", failing("verify") && "verify"].filter(Boolean).join(" and ")}; add it yourself (e.g. ${toml.replace(/^#.*\n/gm, "").replaceAll("\n\n", "; ")})`);
      else if (toml) await writeFileAsk("config.toml", toml, `${tc.name}: one file for the repo settings; see \`bunker --help\` for more keys`);
      if (failing("dockerfile")) await writeFileAsk("Dockerfile", `FROM bunker-claude\n${tc.dockerfile}`, `adds ${tc.name}, which the base image lacks`);
    }
    if (failing("verify")) io.say("Without a verify command in .bunker/config.toml, --merge and --watch can't run.");
    await ensureIgnored(root, env, io);
  }

  // models
  const noModel = !env.BUNKER_MODEL && !env.BUNKER_IMPLEMENTER_MODEL && !env.BUNKER_REVIEWER_MODEL;
  if (!yes && noModel) {
    io.say("\n== Models ==");
    const model = (await io.ask("Default model for every role (blank = Claude default): ", "")).trim();
    const reviewer = (await io.ask("Reviewer model (blank = same as default): ", "")).trim();
    if (model || reviewer) {
      const where = (await io.ask("Save to the repo's .bunker/.env (gitignored) or your user file? [repo/user]: ", "user")).trim();
      const file = where.startsWith("r") ? join(root, ".bunker", ".env") : userFile;
      if (model) await upsertEnvVar(file, "BUNKER_MODEL", model);
      if (reviewer) await upsertEnvVar(file, "BUNKER_REVIEWER_MODEL", reviewer);
      io.say(`saved models to ${file}`);
    }
  }

  // labels
  const missingLabels = LABELS.filter((l) => failing(`label-${l}`));
  if (missingLabels.length && repo) {
    io.say("\n== Labels ==");
    if (await io.confirm(`Create the missing labels (${missingLabels.join(", ")}) with gh label create?`, true)) {
      for (const l of missingLabels) {
        const r = await exec(["gh", "label", "create", l, "--repo", repo.slug, "--description", `bunker: ${l}`, ...(PRIORITY_LABELS.find((p) => p.name === l) ? ["--color", PRIORITY_LABELS.find((p) => p.name === l)!.color] : [])], { env: userEnv(env) });
        io.say(r.code === 0 ? `created label ${l}` : `could not create ${l}: ${redact(r.err.trim())}`);
      }
    }
  }

  // settings: never changed here
  const settings = first.checks.filter((c) => (c.id === "auto-merge" || c.id === "required-check" || c.id === "ci") && !c.ok);
  if (settings.length) {
    io.say("\n== Repo settings (bunker init does not change these) ==");
    for (const c of settings) io.say(`  ✗ ${c.label}\n      ${c.fix}`);
    io.say("  If the repo's settings are managed by IaC (terraform, probot settings, ...), change them there; a UI edit would be reverted.");
  }

  // final doctor
  io.say("\n== Doctor ==");
  const last = await runDoctor({ cwd: opts.cwd, env });
  io.say(formatChecks(last.checks));
  if (last.code === 0) io.say("\nAll set. Start with:\n  bunker --issue <n> --merge\nor work the labelled queue unattended:\n  bunker --watch");
  else io.say("\nStill missing (see ✗ above). Fix those and re-run `bunker doctor`.");
  return last.code;
}

/** Terminal Io: line input from stdin, secrets read without echo. */
export function terminalIo(): Io {
  const lines = (async function* () {
    for await (const l of console) yield l;
  })();
  const tty = !!process.stdin.isTTY;
  const readLine = async (echo: boolean): Promise<string> => {
    if (!tty) return (await lines.next()).value ?? "";
    return new Promise((resolve) => {
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
            stdin.setRawMode(false);
            process.stdout.write("\n");
            process.exit(130);
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
      process.stdout.write(q);
      const a = await readLine(true);
      return a === "" ? (def ?? "") : a;
    },
    secret: async (q) => {
      process.stdout.write(q);
      return readLine(false);
    },
  };
}
