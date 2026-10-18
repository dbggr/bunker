import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopNotifier, resolveMention } from "../src/core/notify.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = origPath;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A bin dir whose `name` script appends its args (one per line) to a log file. */
async function fakeBin(name: string, script = `printf '%s\\n' "$@" >> "$LOG"`) {
  const root = await mkdtemp(join(tmpdir(), "bunker-notify-"));
  dirs.push(root);
  await Bun.write(join(root, name), `#!/bin/sh\nLOG="${root}/calls.log"\n${script}\n`);
  await chmod(join(root, name), 0o755);
  return { root, log: join(root, "calls.log") };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("desktopNotifier()", () => {
  test("Linux: calls notify-send with the title and body", async () => {
    const { root, log } = await fakeBin("notify-send");
    const notify = desktopNotifier({ platform: "linux", path: root });
    notify("bunker: #7 failed", "status verify-failed");
    await settle();
    expect(await Bun.file(log).text()).toContain("bunker: #7 failed\nstatus verify-failed");
  });

  test("macOS: calls osascript with a display notification", async () => {
    const { root, log } = await fakeBin("osascript");
    desktopNotifier({ platform: "darwin", path: root })("bunker", 'a "quoted" body');
    await settle();
    const args = await Bun.file(log).text();
    expect(args).toContain("-e");
    expect(args).toContain('display notification "a \\"quoted\\" body" with title "bunker"');
  });

  test("no notifier binary: silently does nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunker-notify-empty-"));
    dirs.push(root);
    expect(() => desktopNotifier({ platform: "linux", path: root })("t", "b")).not.toThrow();
  });

  test("disabled: never calls the binary", async () => {
    const { root, log } = await fakeBin("notify-send");
    desktopNotifier({ platform: "linux", path: root, enabled: false })("t", "b");
    await settle();
    expect(await Bun.file(log).exists()).toBe(false);
  });

  test("secrets in the title or body are redacted", async () => {
    const { root, log } = await fakeBin("notify-send");
    desktopNotifier({ platform: "linux", path: root })("token ghp_abcdefghijklmnop1234", "body github_pat_ABCDEFGHIJ1234567890");
    await settle();
    const args = await Bun.file(log).text();
    expect(args).not.toContain("ghp_abcdefghijklmnop1234");
    expect(args).not.toContain("github_pat_ABCDEFGHIJ1234567890");
    expect(args).toContain("[REDACTED]");
  });
});

describe("resolveMention()", () => {
  const gh = async (ownerType: string) => {
    const { root } = await fakeBin(
      "gh",
      `case "$*" in *"repo view"*) echo octo;; *"users/octo"*) echo ${ownerType};; *) exit 1;; esac`,
    );
    process.env.PATH = `${root}:${origPath}`;
    return root;
  };

  test("a configured login wins", async () => {
    await gh("User");
    expect(await resolveMention(process.cwd(), process.env as Record<string, string>, "someone")).toBe("@someone");
  });

  test("defaults to the repo owner when it's a user account", async () => {
    await gh("User");
    expect(await resolveMention(process.cwd(), process.env as Record<string, string>)).toBe("@octo");
  });

  test("an organisation owner gives no mention", async () => {
    await gh("Organization");
    expect(await resolveMention(process.cwd(), process.env as Record<string, string>)).toBe("");
  });

  test("gh failing gives no mention", async () => {
    const { root } = await fakeBin("gh", "exit 1");
    process.env.PATH = `${root}:${origPath}`;
    expect(await resolveMention(process.cwd(), process.env as Record<string, string>)).toBe("");
  });
});
