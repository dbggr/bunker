import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLabeler } from "../src/github/labeler.ts";
import { sweepClosedQueued, hasQueuedLabel, isQueuedLabel, markInProgress, unqueue, clearLanded } from "../src/github/labels.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Fake gh: label events name `adder`, `roles` maps login -> role, `labels` is what `issue view` reports. */
async function fakeGh(adder: string, roles: Record<string, string>, labels: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "bunker-labels-"));
  dirs.push(root);
  const roleCases = Object.entries(roles).map(([u, r]) => `  *"collaborators/${u}/permission"*) echo ${r};;`).join("\n");
  await Bun.write(
    join(root, "gh"),
    `#!/bin/sh
echo "$*" >> "${root}/log"
case "$*" in
  *graphql*|*renamed*) exit 0;;
  *created_at*) echo 2026-01-01T00:00:00Z;;
  *"/events"*) echo ${adder};;
${roleCases}
  "issue view"*) echo '${JSON.stringify({ labels: labels.map((name) => ({ name })) })}';;
  *) exit 0;;
esac
`,
  );
  await chmod(join(root, "gh"), 0o755);
  return { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } as Record<string, string>, log: () => Bun.file(join(root, "log")).text().catch(() => "") };
}

describe("queue gate", () => {
  test("accepts bunker:queued added by a maintainer", async () => {
    const g = await fakeGh("mia", { mia: "maintain" });
    expect((await checkLabeler(7, { cwd: process.cwd(), env: g.env })).ok).toBe(true);
  });

  test("refuses bunker:queued added by a non-maintainer", async () => {
    const g = await fakeGh("eve", { eve: "write" });
    const r = await checkLabeler(7, { cwd: process.cwd(), env: g.env });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.denied).toBe(true);
  });

  test("the event query selects only bunker:queued, never in-progress, failed or review", async () => {
    const g = await fakeGh("mia", { mia: "admin" });
    await checkLabeler(7, { cwd: process.cwd(), env: g.env });
    const log = await g.log();
    expect(log).toContain('.label.name == "bunker:queued"');
    expect(log).not.toContain('.label.name == "bunker")');
    for (const other of ["in-progress", "bunker:failed", "bunker:review"]) expect(log).not.toContain(other);
  });

  test("only the queueing labels queue", () => {
    expect(isQueuedLabel("bunker:queued")).toBe(true);
    expect(["bunker:in-progress", "bunker:failed", "bunker:review", "bunker", "bunker-failed", "needs-human-review"].some(isQueuedLabel)).toBe(false);
    expect(hasQueuedLabel([{ name: "bunker:in-progress" }])).toBe(false);
    expect(hasQueuedLabel([{ name: "bunker:in-progress" }, { name: "bunker:queued" }])).toBe(true);
    expect(hasQueuedLabel([{ name: "bunker" }])).toBe(false);
  });
});

describe("label edits", () => {
  test("a run start adds in-progress and removes bunker:failed", async () => {
    const g = await fakeGh("mia", {}, ["bunker:queued", "bunker:failed", "bunker-failed"]);
    await markInProgress(7, process.cwd(), g.env);
    const log = await g.log();
    expect(log).toContain("issue edit 7 --add-label bunker:in-progress");
    expect(log).toContain("issue edit 7 --remove-label bunker:failed");
    expect(log).not.toContain("bunker-failed");
  });

  test("unqueue removes the queueing label", async () => {
    const g = await fakeGh("mia", {}, ["bunker:queued"]);
    await unqueue(7, process.cwd(), g.env, ["--add-label", "bunker:failed"]);
    expect(await g.log()).toContain("issue edit 7 --remove-label bunker:queued --add-label bunker:failed");
  });
});

describe("clearLanded", () => {
  test("drops bunker:queued and bunker:in-progress from a landed issue", async () => {
    const g = await fakeGh("mia", {}, ["bunker:queued"]);
    await clearLanded(5, process.cwd(), g.env);
    const log = await g.log();
    expect(log).toContain("issue edit 5 --remove-label bunker:queued");
    expect(log).toContain("issue edit 5 --remove-label bunker:in-progress");
  });
});

describe("sweepClosedQueued()", () => {
  async function gh(list: string, exit = 0) {
    const root = await mkdtemp(join(tmpdir(), "bunker-sweep-"));
    dirs.push(root);
    await Bun.write(join(root, "gh"), `#!/bin/sh\necho "$*" >> "${root}/log"\nif [ "$1 $2" = "issue list" ]; then echo '${list}'; exit ${exit}; fi\nexit 0\n`);
    await chmod(join(root, "gh"), 0o755);
    return { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } as Record<string, string>, log: () => Bun.file(join(root, "log")).text() };
  }

  test("removes bunker:queued and bunker:in-progress from each closed queued issue", async () => {
    const g = await gh('[{"number":41},{"number":42}]');
    expect(await sweepClosedQueued(process.cwd(), g.env)).toEqual([41, 42]);
    const log = await g.log();
    expect(log).toContain("--state closed");
    expect(log).toContain("issue edit 41 --remove-label bunker:queued --remove-label bunker:in-progress");
    expect(log).toContain("issue edit 42 --remove-label bunker:queued --remove-label bunker:in-progress");
  });

  test("returns [] when gh issue list fails", async () => {
    const g = await gh("[]", 1);
    expect(await sweepClosedQueued(process.cwd(), g.env)).toEqual([]);
    expect(await g.log()).not.toContain("issue edit");
  });

  test("returns [] on malformed JSON", async () => {
    const g = await gh("not json");
    expect(await sweepClosedQueued(process.cwd(), g.env)).toEqual([]);
    expect(await g.log()).not.toContain("issue edit");
  });
});

test("bunker:exclude has create args and is an init label", async () => {
  const { EXCLUDE_LABEL, labelCreateArgs } = await import("../src/github/labels.ts");
  const { LABELS } = await import("../src/cli/commands/doctor.ts");
  expect(EXCLUDE_LABEL).toBe("bunker:exclude");
  expect(labelCreateArgs(EXCLUDE_LABEL)).toContain("--color");
  expect(LABELS).toContain(EXCLUDE_LABEL);
});

test("bunker:force is a known label, checked by doctor", async () => {
  const { FORCE_LABEL, labelCreateArgs } = await import("../src/github/labels.ts");
  const { LABELS, OPTIONAL_LABELS } = await import("../src/cli/commands/doctor.ts");
  expect(FORCE_LABEL).toBe("bunker:force");
  expect(labelCreateArgs(FORCE_LABEL)).toContain("--color");
  expect(LABELS).toContain(FORCE_LABEL);
  expect(OPTIONAL_LABELS).toContain(FORCE_LABEL);
});
