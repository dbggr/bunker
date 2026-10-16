import { beforeEach } from "bun:test";
import { output } from "../src/output.ts";

// Fake agents print <issue> blocks and text; keep that out of `bun test`'s own output.
beforeEach(() => {
  output.verbose = false;
  output.write = () => true;
});
