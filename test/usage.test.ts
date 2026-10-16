import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode, noSandbox, review, run, runAll, type Agent } from "../src/index.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunker-usage-"));
  dirs.push(dir);
  await $`git init -q -b main ${dir}`;
  await $`git -C ${dir} config user.name Test`;
  await $`git -C ${dir} config user.email test@example.com`;
  await $`git -C ${dir} commit -q --allow-empty -m init`;
  return dir;
}

const json = (result: string, cost: number, ms: number) =>
  JSON.stringify({ type: "result", result, total_cost_usd: cost, duration_ms: ms });

describe("claudeCode({ json })", () => {
  test("requests JSON output only when asked", () => {
    expect(claudeCode().command("x")).not.toContain("--output-format");
    const cmd = claudeCode({ json: true }).command("x");
    expect(cmd.slice(cmd.indexOf("--output-format"), cmd.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(cmd).toContain("--verbose");
  });

  test("parse() extracts result text, cost and duration", () => {
    const out = claudeCode({ json: true }).parse!(json("done <promise>COMPLETE</promise>", 0.25, 1200));
    expect(out).toEqual({ text: "done <promise>COMPLETE</promise>", usage: { costUsd: 0.25, durationMs: 1200 } });
  });

  test("parse() falls back to raw stdout when it is not JSON", () => {
    expect(claudeCode({ json: true }).parse!("plain text")).toEqual({ text: "plain text" });
  });

  test("no parse() without json", () => {
    expect(claudeCode().parse).toBeUndefined();
  });
});

function jsonAgent(script: (mode: string) => string): Agent {
  return {
    command: (_p, mode = "write") => ["sh", "-c", script(mode)],
    parse: (stdout) => {
      const j = JSON.parse(stdout);
      return { text: j.result, usage: { costUsd: j.total_cost_usd, durationMs: j.duration_ms } };
    },
  };
}

describe("usage totals", () => {
  test("review() sums implementer and reviewer over all rounds and matches on parsed text", async () => {
    const repo = await makeRepo();
    let reviews = 0;
    const agent = jsonAgent((mode) => {
      if (mode === "write") {
        const out = json("impl", 1, 100);
        return `N=$(git rev-list --count HEAD); echo $N > f$N.txt && git add . && git commit -qm "impl $N"; echo '${out}'`;
      }
      const out = ++reviews === 1 ? json("fix it", 0.5, 50) : json("<review>APPROVE</review>", 0.5, 50);
      return `echo '${out}'`;
    });
    const r = await review({ cwd: repo, prompt: "do it", agent, sandbox: noSandbox() });
    expect(r.status).toBe("approved");
    expect(r.rounds[0]!.feedback).toBe("fix it");
    expect(r.usage?.costUsd).toBeCloseTo(3);
    expect(r.usage?.durationMs).toBe(300);
  });

  test("review() usage is undefined when the agent reports none", async () => {
    const repo = await makeRepo();
    const agent: Agent = {
      command: (_p, mode = "write") => [
        "sh", "-c",
        mode === "write" ? `echo a > a.txt && git add . && git commit -qm a` : "echo '<review>APPROVE</review>'",
      ],
    };
    const r = await review({ cwd: repo, prompt: "x", agent, sandbox: noSandbox() });
    expect(r.usage).toBeUndefined();
  });

  test("run() sums iterations and uses parsed text for the completion signal", async () => {
    const repo = await makeRepo();
    const agent = jsonAgent(() => `echo '${json("<promise>COMPLETE</promise>", 2, 10)}'`);
    const r = await run({ cwd: repo, prompt: "x", agent, sandbox: noSandbox(), maxIterations: 3 });
    expect(r.completionSignal).toBe("<promise>COMPLETE</promise>");
    expect(r.iterations).toHaveLength(1);
    expect(r.usage).toEqual({ costUsd: 2, durationMs: 10 });
  });

  test("runAll() keeps the usage of a failed task", async () => {
    const repo = await makeRepo();
    const agent = jsonAgent(() => `echo '${json("boom", 1.5, 20)}'; exit 3`);
    const [r] = await runAll({ cwd: repo, tasks: [{ prompt: "x" }], agent, sandbox: noSandbox() });
    expect(r!.status).toBe("failed");
    expect(r!.usage).toEqual({ costUsd: 1.5, durationMs: 20 });
  });
});
