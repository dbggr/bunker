import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes via a temp file and a rename, so an interrupted run leaves the old file or the new one, never half of either. */
export async function atomicWrite(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, ...(mode === 0o600 ? { mode: 0o700 } : {}) });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, content, mode === undefined ? {} : { mode });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Sets a top-level `key = value` in TOML text (replacing the line, else inserting before the first [table]). Other lines stay. */
export function setTomlKey(text: string, key: string, value: string | number | string[]): string {
  const rendered = `${key} = ${typeof value === "number" ? value : JSON.stringify(value)}`;
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const end = firstTable < 0 ? lines.length : firstTable;
  const idx = lines.slice(0, end).findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (idx >= 0) lines[idx] = rendered;
  else if (firstTable < 0) lines.push(rendered);
  else lines.splice(firstTable, 0, rendered, "");
  return lines.join("\n") + "\n";
}

/** Reads a file's text, or "" when it doesn't exist. */
export async function readText(path: string): Promise<string> {
  const f = Bun.file(path);
  return (await f.exists()) ? f.text() : "";
}
