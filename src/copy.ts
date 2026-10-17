import { $, Glob } from "bun";
import { cp, mkdir, realpath, readdir, stat, appendFile, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { addSecrets } from "./redact.ts";

/** The patterns to copy: `override` if given, else the lines of `<dir>/.bunker/copy` (`#` comments, blanks skipped). */
export async function copyPatterns(dir: string, override?: string[]): Promise<string[]> {
  let patterns = override;
  if (!patterns) {
    const file = Bun.file(join(dir, ".bunker", "copy"));
    patterns = (await file.exists()) ? (await file.text()).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  }
  for (const p of patterns) {
    if (isAbsolute(p) || p.split(/[\\/]/).includes("..")) throw new Error(`copy path outside the repo: ${p}`);
  }
  return patterns;
}

async function walk(root: string, rel: string): Promise<string[]> {
  if (!(await stat(join(root, rel))).isDirectory()) return [rel];
  const out: string[] = [];
  for (const e of await readdir(join(root, rel))) out.push(...(await walk(root, join(rel, e))));
  return out;
}

const escapeIgnore = (p: string) => "/" + p.replace(/^[ #!]|[*?[\]\\]/g, (c) => "\\" + c);

/**
 * Copies the files matching `patterns` from `src` into the same paths in `dest` (a worktree of `src`'s repo).
 * Tracked files are left alone. Copied files are added to the worktree's info/exclude and their
 * `.env*` values to the redaction set. Missing patterns warn. Returns the copied files, relative.
 */
export async function copyIntoWorktree(src: string, dest: string, patterns: string[]): Promise<string[]> {
  const root = await realpath(src);
  const tracked = new Set((await $`git -C ${dest} ls-files -z`.text()).split("\0"));
  const copied = new Set<string>();
  for (const pattern of await copyPatterns(src, patterns)) {
    const matches = new Set<string>();
    if (/[*?[\]{}]/.test(pattern)) for await (const m of new Glob(pattern).scan({ cwd: src, dot: true, onlyFiles: false })) matches.add(m);
    else if (await Bun.file(join(src, pattern)).exists() || (await stat(join(src, pattern)).catch(() => undefined))?.isDirectory()) matches.add(pattern);
    if (matches.size === 0) {
      console.warn(`bunker: copy: ${pattern} not found, skipped`);
      continue;
    }
    for (const m of matches) {
      const real = await realpath(join(src, m));
      if (real !== root && !real.startsWith(root + sep)) throw new Error(`copy path outside the repo: ${m}`);
      for (const f of await walk(src, m.replace(/\/+$/, ""))) {
        if (tracked.has(f) || f === ".git" || f.startsWith(".git" + sep)) continue;
        await mkdir(dirname(join(dest, f)), { recursive: true });
        await cp(join(src, f), join(dest, f));
        copied.add(f);
      }
    }
  }
  const files = [...copied];
  if (files.length === 0) return files;

  const exclude = resolve(dest, (await $`git -C ${dest} rev-parse --git-path info/exclude`.text()).trim());
  await mkdir(dirname(exclude), { recursive: true });
  const have = new Set((await readFile(exclude, "utf8").catch(() => "")).split("\n"));
  const add = files.map(escapeIgnore).filter((l) => !have.has(l));
  if (add.length) await appendFile(exclude, add.join("\n") + "\n");

  const secrets: string[] = [];
  for (const f of files) {
    const base = f.split("/").at(-1)!;
    if (!base.startsWith(".env") && !base.endsWith(".env")) continue;
    for (const raw of (await Bun.file(join(dest, f)).text()).split("\n")) {
      const line = raw.trim().replace(/^export\s+/, "");
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      let value = line.slice(eq + 1).trim();
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
      secrets.push(value);
    }
  }
  addSecrets(secrets);
  return files;
}

/** Copied files that commits in `base..HEAD` of `worktree` touch, if any. */
export async function committedCopies(worktree: string, base: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const touched = new Set((await $`git -C ${worktree} diff --name-only -z ${base}..HEAD`.text()).split("\0"));
  return files.filter((f) => touched.has(f));
}

export const copyRejection = (found: string[]) => `commit includes copied file${found.length > 1 ? "s" : ""}: ${found.join(", ")}`;
