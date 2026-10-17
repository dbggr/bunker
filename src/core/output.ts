/** Where raw sandbox output goes. Quiet by default: only `--verbose` / BUNKER_VERBOSE=1 streams it. */
export const output = {
  verbose: ["1", "true"].includes(process.env.BUNKER_VERBOSE ?? ""),
  write: (s: string): unknown => process.stdout.write(s),
  /** Where bunker's own warnings and progress notes go (stderr by default). Tests silence or capture it. */
  warn: (line: string): unknown => console.error(line),
};

/** The last `n` lines of `text`. */
export function tailLines(text: string, n = 40): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

/** "151 pass, 8 skip" from `bun test` style output; empty when nothing parses. */
export function testCounts(text: string): string {
  return (["pass", "skip", "fail"] as const)
    .map((k) => {
      const n = new RegExp(`^\\s*(\\d+) ${k}\\b`, "m").exec(text)?.[1];
      return n !== undefined && (k !== "fail" || n !== "0") ? `${n} ${k}` : "";
    })
    .filter(Boolean)
    .join(", ");
}
