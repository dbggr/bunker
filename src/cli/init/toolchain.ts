import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Toolchain {
  name: string;
  setup: string;
  verify: string;
  /** Dockerfile lines after `FROM bunker-claude`: the runtime the base image lacks. */
  dockerfile: string;
  /** Said alongside the proposal (why this guess, what to check). */
  note?: string;
  /** Gitignored files that exist locally and that setup/verify need in a fresh worktree (the `copy` key). */
  copy?: string[];
}

/** A package of a JS monorepo, relative to the repo root. */
export interface WorkspacePackage {
  dir: string;
  name: string;
}

const NODE_RUNTIME = "COPY --from=node:22-slim /usr/local/ /usr/local/";
const BUN_RUNTIME = "COPY --from=oven/bun:1-slim /usr/local/bin/bun /usr/local/bin/bun\nRUN ln -s /usr/local/bin/bun /usr/local/bin/bunx";
const apt = (pkgs: string) => `RUN apt-get update && apt-get install -y --no-install-recommends ${pkgs} && rm -rf /var/lib/apt/lists/*`;

type Pm = "bun" | "pnpm" | "yarn" | "npm";

function readJson(path: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function nodeToolchain(root: string): Toolchain | undefined {
  const has = (f: string) => existsSync(join(root, f));
  const pkg = readJson(join(root, "package.json"));
  const declared = typeof pkg?.packageManager === "string" ? (/^(bun|pnpm|yarn|npm)@/.exec(pkg.packageManager)?.[1] as Pm | undefined) : undefined;
  let pm: Pm | undefined;
  let locked = true;
  if (has("bun.lock") || has("bun.lockb")) pm = "bun";
  else if (has("pnpm-lock.yaml")) pm = "pnpm";
  else if (has("yarn.lock")) pm = "yarn";
  else if (has("package-lock.json")) pm = "npm";
  else if (has("package.json") || has("pnpm-workspace.yaml")) {
    pm = declared ?? (has("pnpm-workspace.yaml") ? "pnpm" : "npm");
    locked = false;
  }
  if (!pm) return undefined;
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const placeholder = /no test specified/.test(scripts.test ?? "");
  const hasTest = !!scripts.test && !placeholder;
  const notes: string[] = [];
  if (!locked) notes.push(`package.json has no lockfile, so setup is \`${pm} install\`; commit a lockfile and switch to a frozen install for reproducible runs`);
  let verify: string;
  if (pm === "bun") {
    // bun has its own runner: `bun test` finds *.test.ts files even with no "test" script
    verify = "bun test" + (!pkg || scripts.typecheck ? " && bun run typecheck" : "");
  } else if (hasTest) verify = `${pm} test`;
  else if (scripts.build) {
    verify = `${pm} run build`;
    notes.push("no test script in package.json, so verify only builds; add tests and `npm test` for a stronger check");
  } else {
    verify = `${pm} test`;
    notes.push("no test script in package.json: verify will fail until you add one (or change verify)");
  }
  const setup = { bun: locked ? "bun install --frozen-lockfile" : "bun install", pnpm: locked ? "pnpm install --frozen-lockfile" : "pnpm install", yarn: locked ? "yarn install --frozen-lockfile" : "yarn install", npm: locked ? "npm ci" : "npm install" }[pm];
  const dockerfile = pm === "bun" ? BUN_RUNTIME : pm === "npm" ? NODE_RUNTIME : `${NODE_RUNTIME}\nRUN corepack enable`;
  const copy = ignoredEnvFiles(root, ["."]);
  if (copy.length) notes.push("`.env` is gitignored, so it is copied into each worktree (copy)");
  return { name: pm, setup, verify, dockerfile, ...(copy.length ? { copy } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) };
}

const PHP_BUILTIN = new Set(["core", "ctype", "date", "filter", "hash", "iconv", "json", "libxml", "openssl", "pcre", "pdo", "phar", "posix", "pcntl", "random", "reflection", "session", "sodium", "spl", "standard", "tokenizer", "opcache", "zend opcache", "zlib"]);
/** composer `ext-*` name -> Debian (sury) package suffix; "" means nothing to install. */
const PHP_EXT: Record<string, string> = { pdo_pgsql: "pgsql", pgsql: "pgsql", pdo_mysql: "mysql", mysqli: "mysql", mysqlnd: "mysql", pdo_sqlite: "sqlite3", sqlite3: "sqlite3", dom: "xml", simplexml: "xml", xmlreader: "xml", xmlwriter: "xml", xml: "xml", mbstring: "mbstring", fileinfo: "", readline: "readline" };

/** The composer.json nearest the root: the root itself, else the first subdirectory (two levels at most) that has one. */
function findComposerDir(root: string): string | undefined {
  if (existsSync(join(root, "composer.json"))) return ".";
  const skip = (n: string) => n.startsWith(".") || n === "vendor" || n === "node_modules";
  const subdirs = (rel: string) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true }).filter((e) => e.isDirectory() && !skip(e.name)).map((e) => (rel === "." ? e.name : `${rel}/${e.name}`)).sort();
    } catch {
      return [];
    }
  };
  const level1 = subdirs(".");
  for (const d of level1) if (existsSync(join(root, d, "composer.json"))) return d;
  for (const d of level1) for (const d2 of subdirs(d)) if (existsSync(join(root, d2, "composer.json"))) return d2;
  return undefined;
}

/** The lowest PHP version a composer constraint allows, as `major.minor` (">=8.5" -> "8.5", "^8.2 || ^8.3" -> "8.2"). */
function phpVersion(constraint: unknown): string | undefined {
  if (typeof constraint !== "string") return undefined;
  const found = [...constraint.matchAll(/(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  if (!found.length) return undefined;
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return `${found[0]![0]}.${found[0]![1]}`;
}

/** Whether the tests need a database service the sandbox lacks: CI `services:` or a non-local DB host in `.env.test`. */
function phpNeedsDatabase(root: string, dir: string): boolean {
  try {
    for (const f of readdirSync(join(root, ".github", "workflows"))) if (/\.ya?ml$/.test(f) && /^\s*services:/m.test(readFileSync(join(root, ".github", "workflows", f), "utf8"))) return true;
  } catch {}
  const local = /^(localhost|127\.0\.0\.1|::1)$/;
  for (const d of new Set([dir, "."])) {
    try {
      const env = readFileSync(join(root, d, ".env.test"), "utf8");
      for (const m of env.matchAll(/^\s*([A-Z_]*(?:DATABASE|DB)[A-Z_]*)\s*=\s*["']?(.*?)["']?\s*$/gm)) {
        const v = m[2]!;
        const url = /^(pgsql|postgres(?:ql)?|mysql|mariadb|mongodb|sqlsrv):\/\/(?:[^@/]*@)?([^:/?]+)/i.exec(v);
        if (url && !local.test(url[2]!)) return true;
        if (/HOST$/.test(m[1]!) && /^[\w.-]+$/.test(v) && !local.test(v)) return true;
      }
    } catch {}
  }
  return false;
}

/** `.env` files in the given directories that exist locally but are gitignored (so a fresh worktree lacks them). */
function ignoredEnvFiles(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    const rel = d === "." ? ".env" : `${d}/.env`;
    if (!existsSync(join(root, rel))) continue;
    const ignored = Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", rel], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    if (ignored) out.push(rel);
  }
  return out;
}

function phpToolchain(root: string): Toolchain | undefined {
  const dir = findComposerDir(root);
  if (dir === undefined) return undefined;
  const composer = readJson(join(root, dir, "composer.json"));
  const cd = dir === "." ? "" : `cd ${dir} && `;
  const notes: string[] = [];
  if (dir !== ".") notes.push(`composer.json is in ${dir}/, so setup and verify run from there`);
  let verify = `${cd}${composer?.scripts?.test ? "composer test" : "vendor/bin/phpunit"}`;
  if (phpNeedsDatabase(root, dir)) {
    const has = (f: string) => existsSync(join(root, dir, f));
    verify = [`${cd}composer validate --no-check-publish`, ...(has("bin/console") ? ["php bin/console lint:container", ...(has("config") ? ["php bin/console lint:yaml config"] : [])] : [])].join(" && ");
    notes.push("the tests need a database (CI services or a DB host in .env.test) and the sandbox has none, so verify is a DB-free check (composer validate, plus Symfony container and YAML lint when present); the real tests are left to CI. Add a verify that starts or fakes the database to run them here");
  }
  const copy = ignoredEnvFiles(root, [dir]);
  if (copy.length) notes.push(`${copy.join(", ")} is gitignored but setup needs it, so it is copied into each worktree (copy)`);
  const v = phpVersion(composer?.require?.php);
  const exts = new Set(["cli", "xml", "mbstring"]);
  const unknown: string[] = [];
  for (const key of Object.keys(composer?.require ?? {})) {
    const m = /^ext-(.+)$/.exec(key);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (PHP_BUILTIN.has(name)) continue;
    if (name in PHP_EXT) {
      if (PHP_EXT[name]) exts.add(PHP_EXT[name]!);
    } else {
      exts.add(name);
      unknown.push(name);
    }
  }
  if (unknown.length) notes.push(`guessed the Debian packages for ext-${unknown.join(", ext-")}; check they exist`);
  const pkgs = (prefix: string) => [...exts].map((e) => `${prefix}-${e}`).join(" ");
  // distro apt lags behind composer's `require.php`, so a stated version comes from the sury repo
  const runtime = v
    ? [
        apt("ca-certificates curl lsb-release unzip"),
        "RUN curl -sSLo /tmp/sury.deb https://packages.sury.org/debsuryorg-archive-keyring.deb && dpkg -i /tmp/sury.deb && rm /tmp/sury.deb \\",
        '    && echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" > /etc/apt/sources.list.d/php.list',
        apt(pkgs(`php${v}`)),
      ].join("\n")
    : apt(`${pkgs("php")} unzip`);
  return {
    name: "php",
    setup: `${cd}composer install --no-interaction`,
    verify,
    dockerfile: `${runtime}\nCOPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer`,
    ...(copy.length ? { copy } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}

/**
 * Every toolchain the repo's files point at, most likely first. More than one means the caller should ask;
 * none means it should ask for the commands.
 */
export function detectToolchains(root: string): Toolchain[] {
  const has = (f: string) => existsSync(join(root, f));
  const out: Toolchain[] = [];
  const node = nodeToolchain(root);
  if (node) out.push(node);
  const php = phpToolchain(root);
  if (php) out.push(php);
  if (has("pyproject.toml") || has("requirements.txt"))
    out.push({ name: "python", setup: has("pyproject.toml") ? "pip install -e ." : "pip install -r requirements.txt", verify: "pytest", dockerfile: apt("python3 python3-pip python3-venv") });
  if (has("Cargo.toml")) out.push({ name: "rust", setup: "cargo fetch", verify: "cargo test", dockerfile: apt("cargo") });
  if (has("go.mod")) out.push({ name: "go", setup: "go mod download", verify: "go test ./...", dockerfile: "COPY --from=golang:1.23 /usr/local/go /usr/local/go\nENV PATH=/usr/local/go/bin:$PATH" });
  return out;
}

/** Generic presets the init toolchain step offers, in list order (detection refines the commands of the ones it finds). */
export function toolchainPresets(): Toolchain[] {
  const node = (name: string, setup: string, dockerfile: string): Toolchain => ({ name, setup, verify: `${name} test`, dockerfile });
  return [
    node("bun", "bun install --frozen-lockfile", BUN_RUNTIME),
    node("npm", "npm install", NODE_RUNTIME),
    node("pnpm", "pnpm install --frozen-lockfile", `${NODE_RUNTIME}\nRUN corepack enable`),
    node("yarn", "yarn install --frozen-lockfile", `${NODE_RUNTIME}\nRUN corepack enable`),
    { name: "php", setup: "composer install --no-interaction", verify: "composer test", dockerfile: `${apt("php-cli php-xml php-mbstring unzip")}\nCOPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer` },
    { name: "python", setup: "pip install -r requirements.txt", verify: "pytest", dockerfile: apt("python3 python3-pip python3-venv") },
    { name: "rust", setup: "cargo fetch", verify: "cargo test", dockerfile: apt("cargo") },
    { name: "go", setup: "go mod download", verify: "go test ./...", dockerfile: "COPY --from=golang:1.23 /usr/local/go /usr/local/go\nENV PATH=/usr/local/go/bin:$PATH" },
  ];
}

/** Several toolchains as one: setup and verify joined with `&&` in the given order, Dockerfile lines from each (repeats dropped). */
export function combineToolchains(list: Toolchain[]): Toolchain | undefined {
  if (list.length <= 1) return list[0];
  const seen = new Set<string>();
  const dockerfile = list.flatMap((t) => t.dockerfile.split("\n")).filter((l) => !seen.has(l) && !!seen.add(l)).join("\n");
  const notes = list.map((t) => t.note).filter(Boolean);
  const copy = [...new Set(list.flatMap((t) => t.copy ?? []))];
  return {
    ...(copy.length ? { copy } : {}),
    name: list.map((t) => t.name).join("+"),
    setup: list.map((t) => t.setup).filter(Boolean).join(" && "),
    verify: list.map((t) => t.verify).filter(Boolean).join(" && "),
    dockerfile,
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}

/** The most likely toolchain, or undefined. */
export const detectToolchain = async (root: string): Promise<Toolchain | undefined> => detectToolchains(root)[0];

/** Packages of a JS workspace (package.json `workspaces`, or pnpm-workspace.yaml); simple `dir/*` and `dir` globs only. */
export function workspacePackages(root: string): WorkspacePackage[] {
  const globs: string[] = [];
  const ws = readJson(join(root, "package.json"))?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws);
  else if (Array.isArray(ws?.packages)) globs.push(...ws.packages);
  try {
    const y = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    for (const m of y.matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?/gm)) globs.push(m[1]!);
  } catch {}
  const dirs = new Set<string>();
  for (const g of globs) {
    if (g.startsWith("!")) continue;
    const clean = g.replace(/\/+$/, "");
    if (clean.endsWith("/*") || clean.endsWith("/**")) {
      const base = clean.replace(/\/\*+$/, "");
      try {
        for (const e of readdirSync(join(root, base), { withFileTypes: true })) if (e.isDirectory() && existsSync(join(root, base, e.name, "package.json"))) dirs.add(`${base}/${e.name}`);
      } catch {}
    } else if (existsSync(join(root, clean, "package.json"))) dirs.add(clean);
  }
  return [...dirs].sort().map((dir) => ({ dir, name: readJson(join(root, dir, "package.json"))?.name ?? dir }));
}

/** Narrows a JS toolchain's verify to one workspace package; setup still installs the whole repo. */
export function forPackage(root: string, tc: Toolchain, pkg: WorkspacePackage): Toolchain {
  const scripts: Record<string, string> = readJson(join(root, pkg.dir, "package.json"))?.scripts ?? {};
  const script = scripts.test ? "test" : scripts.build ? "build" : "test";
  const verify = {
    bun: `bun run --cwd ${pkg.dir} ${script}`,
    pnpm: `pnpm --filter ./${pkg.dir} run ${script}`,
    yarn: `yarn workspace ${pkg.name} run ${script}`,
    npm: `npm run ${script} --workspace ${pkg.dir}`,
  }[tc.name];
  return verify ? { ...tc, verify, note: `verify runs only ${pkg.name} (${pkg.dir})` } : tc;
}

/** The GitHub Actions workflow bunker proposes: one job, `test`, which runs the toolchain's setup and verify. */
export function ciWorkflow(tc: Toolchain, branch: string): string {
  const uses: Record<string, string[]> = {
    bun: ["- uses: oven-sh/setup-bun@v2"],
    pnpm: ["- uses: actions/setup-node@v4", "  with:", "    node-version: 22", "- run: corepack enable"],
    yarn: ["- uses: actions/setup-node@v4", "  with:", "    node-version: 22", "- run: corepack enable"],
    npm: ["- uses: actions/setup-node@v4", "  with:", "    node-version: 22"],
    php: ["- uses: shivammathur/setup-php@v2", "  with:", "    php-version: '8.3'", "    tools: composer"],
    python: ["- uses: actions/setup-python@v5", "  with:", "    python-version: '3.12'", "- run: pip install pytest"],
    go: ["- uses: actions/setup-go@v5", "  with:", "    go-version: stable"],
    rust: [],
  };
  const steps = ["- uses: actions/checkout@v4", ...tc.name.split("+").flatMap((n) => uses[n] ?? []), `- run: ${JSON.stringify(tc.setup)}`, `- run: ${JSON.stringify(tc.verify)}`];
  return [
    "# Written by `bunker init`. bunker merges only when this job (`test`) passes, so keep the job name.",
    "name: CI",
    "on:",
    "  pull_request:",
    "  push:",
    `    branches: [${branch}]`,
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps.map((s) => `      ${s}`),
    "",
  ].join("\n");
}
