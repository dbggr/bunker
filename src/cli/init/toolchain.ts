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
  return { name: pm, setup, verify, dockerfile, ...(notes.length ? { note: notes.join("; ") } : {}) };
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
  if (has("composer.json"))
    out.push({ name: "php", setup: "composer install --no-interaction", verify: "composer test", dockerfile: `${apt("php-cli php-xml php-mbstring unzip")}\nCOPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer` });
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
  return {
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
