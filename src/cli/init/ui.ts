type Env = Record<string, string | undefined>;

/** How `bunker init` draws itself: colour, glyphs and links degrade with the terminal. */
export interface Ui {
  color: boolean;
  unicode: boolean;
  links: boolean;
  columns: number;
  bold(s: string): string;
  dim(s: string): string;
  /** A clickable OSC 8 link where the terminal supports it, else the plain URL (or `label: url`). */
  link(url: string, label?: string): string;
  /** Word-wraps to the terminal width (at most 80 columns), indenting every line. URLs and commands are never split. */
  wrap(text: string, indent?: number): string;
  /** Colours ✓/✗ marks, or swaps them for ASCII when the terminal can't draw them. */
  marks(text: string): string;
  /** `[3/8] Sandbox image` */
  header(n: number, total: number, title: string): string;
  /** `▰▰▰▱▱▱▱▱ 3 of 8` */
  progress(n: number, total: number): string;
}

export function makeUi(env: Env, o: { tty?: boolean; columns?: number } = {}): Ui {
  const tty = !!o.tty;
  const noColor = !!env.NO_COLOR;
  const dumb = env.TERM === "dumb";
  const color = !noColor && !dumb && (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" ? env.FORCE_COLOR !== "0" : tty);
  const unicode = !noColor && !dumb;
  const links = !dumb && !noColor && (env.FORCE_HYPERLINK !== undefined && env.FORCE_HYPERLINK !== "" ? env.FORCE_HYPERLINK !== "0" : tty);
  const columns = Math.max(40, Math.min(o.columns ?? 80, 80));
  const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const green = sgr("32");
  const red = sgr("31");
  const bold = sgr("1");
  const dim = sgr("2");
  const ui: Ui = {
    color,
    unicode,
    links,
    columns,
    bold,
    dim,
    link: (url, label) => (links ? `\x1b]8;;${url}\x1b\\${label ?? url}\x1b]8;;\x1b\\` : label && label !== url ? `${label} (${url})` : url),
    wrap(text, indent = 0) {
      const pad = " ".repeat(indent);
      const width = columns - indent;
      return text
        .split("\n")
        .map((line) => {
          // keep lines that are already indented (lists, commands) as written
          if (/^\s/.test(line) || line.length <= width) return pad + line;
          const out: string[] = [];
          let cur = "";
          for (const word of line.split(" ")) {
            if (cur && cur.length + 1 + word.length > width) {
              out.push(cur);
              cur = word;
            } else cur = cur ? `${cur} ${word}` : word;
          }
          out.push(cur);
          return out.map((l) => pad + l).join("\n");
        })
        .join("\n");
    },
    marks: (text) => text.replace(/[✓✗]/g, (m) => (unicode ? (m === "✓" ? green(m) : red(m)) : m === "✓" ? "[ok]" : "[x]")),
    header: (n, total, title) => bold(`[${n}/${total}] ${title}`),
    progress(n, total) {
      const [on, off] = unicode ? ["▰", "▱"] : ["#", "-"];
      return dim(`${on.repeat(n)}${off.repeat(Math.max(0, total - n))} ${n} of ${total}`);
    },
  };
  return ui;
}
