// Copies the repo's docs/*.md into site/guide/ so the site is built from the one source of truth.
// Rewrites the README-style links that point outside docs/ to their GitHub URLs.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const src = join(root, "docs");
const dest = join(import.meta.dir, "..", "guide");
const repo = "https://github.com/dbggr/tool-bunker/blob/main";

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of readdirSync(src).filter((f) => f.endsWith(".md"))) {
  const md = readFileSync(join(src, f), "utf8")
    // ../README.md, ../release/…, ../src/… → GitHub; sibling docs links stay relative
    .replace(/\]\((\.\.\/[^)#\s]+)(#[^)\s]*)?\)/g, (_, p: string, h = "") => `](${repo}/${p.replace(/^\.\.\//, "")}${h})`);
  writeFileSync(join(dest, f), md);
}
console.log(`prepare-docs: ${readdirSync(dest).length} pages → site/guide/`);
