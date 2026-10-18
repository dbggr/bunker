import { parseArgs } from "node:util";
import { FlagError } from "../core/settings.ts";
import type { options } from "../core/options.ts";

/** The parsed CLI flags, as main.ts's parseArgs call returns them. */
export type CliValues = ReturnType<typeof parseArgs<{ allowPositionals: true; options: typeof options }>>["values"];

export const guardFlags = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (!(e instanceof FlagError)) throw e;
    console.error(`bunker: ${e.message}`);
    process.exit(2);
  }
};
