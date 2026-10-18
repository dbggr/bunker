import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noSandbox, type Agent } from "../src/index.ts";
import { runQueue } from "../src/pipeline/queue.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const dirs: string[] = [];
const origPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = origPath;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const APPROVE = "<verdict>{\"approved\":true,\"required_changes\":[]}</verdict>";

/**
 * `work` gets the issue number and how many times that issue has been attempted, and returns shell that edits files.
 * `waitFor` makes an issue's first attempt block until the given issues' agents have finished, and `rendezvous` makes
 * the listed issues wait for each other, so it only completes if they run concurrently. Both are barriers on marker
 * files in `sync`, not sleeps; the polling cap is far above any load, so a broken barrier fails instead of hanging.
 */
function fakeAgent(sync: string, work: (issue: number, attempt: number) => string, waitFor: Record<number, number[]> = {}, rendezvous: number[] = []): Agent {
  const wait = (files: string[]) => files.map((f) => `i=0; while [ ! -f "${join(sync, f)}" ]; do i=$((i+1)); [ $i -gt 3000 ] && exit 1; sleep 0.01; done; `).join("");
  const attempts: Record<number, number> = {};
  return {
    command(prompt, mode = "write") {
      if (mode !== "write") return ["sh", "-c", `echo '${APPROVE}'`];
      const issue = Number(/issue #(\d+)/.exec(prompt)![1]);
      attempts[issue] = (attempts[issue] ?? 0) + 1;
      const pre = (rendezvous.includes(issue) ? `touch "${join(sync, `started-${issue}`)}"; ${wait(rendezvous.filter((n) => n !== issue).map((n) => `started-${n}`))}` : "") + (attempts[issue] === 1 && waitFor[issue] ? wait(waitFor[issue]!.map((n) => `done-${n}`)) : "");
      return ["sh", "-c", `${pre}${work(issue, attempts[issue]!)} && git add . && git commit -qm "feat: impl"; rc=$?; touch "${join(sync, `done-${issue}`)}"; exit $rc`];
    },
  };
}

async function setup(numbers: number[]) {
  const root = await mkdtemp(join(tmpdir(), "bunker-parallel-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  await $`git init -q --bare -b main ${origin}`;
  await $`git init -q -b main ${repo}`;
  await $`git -C ${repo} config user.name Test`;
  await $`git -C ${repo} config user.email test@example.com`;
  await $`git -C ${repo} commit -q --allow-empty -m init`;
  await $`git -C ${repo} remote add origin ${origin}`;
  await $`git -C ${repo} push -q -u origin main`;
  await $`mkdir ${bin}`;
  await Bun.write(join(root, "list.json"), JSON.stringify(numbers.map((n) => ({ number: n, title: `Issue ${n}`, createdAt: `2026-01-0${n}T00:00:00Z` }))));
  for (const n of numbers) {
    await Bun.write(join(root, `issue-${n}.json`), JSON.stringify({ number: n, title: `Issue ${n}`, body: "Do it.", state: "OPEN", labels: [{ name: "bunker" }] }));
  }
  // `pr merge` fast-forwards origin/main to the PR branch (so it must contain main) and records the order.
  await Bun.write(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1" = "api" ]; then case "$*" in *"/rules/branches/"*) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test"}]}}]'; exit 0;; *graphql*|*renamed*) exit 0;; *created_at*) echo 2020-01-01T00:00:00Z; exit 0;; *"/events"*) echo owner; exit 0;; *"/permission"*) echo admin; exit 0;; esac; fi
if [ "$1 $2" = "issue list" ]; then
  if echo "$*" | grep -q -- "--label bunker-blocked"; then echo '[]'; else cat "${root}/list.json"; fi
  exit 0
fi
if [ "$1 $2" = "issue view" ]; then cat "${root}/issue-$3.json"; exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/$(git rev-parse --abbrev-ref HEAD | tr '/' '-')"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then
  if [ -f "${root}/merged-$(echo "$3" | sed 's|.*/pull/||')" ]; then echo '{"state":"MERGED","mergeCommit":{"oid":"abc"}}'; else echo '{"state":"OPEN","mergeCommit":null}'; fi
  exit 0
fi
if [ "$1 $2" = "pr merge" ]; then
  b=$(git rev-parse --abbrev-ref HEAD)
  git merge-base --is-ancestor "$(git --git-dir="${origin}" rev-parse refs/heads/main)" HEAD || { echo "not up to date" >&2; exit 1; }
  git --git-dir="${origin}" update-ref refs/heads/main "refs/heads/$b"
  echo "$b" >> "${root}/merge-order.log"
  touch "${root}/merged-$(echo "$3" | sed 's|.*/pull/||')"
  exit 0
fi
exit 0
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return { repo, root, origin };
}

const show = (origin: string, file: string) => $`git --git-dir=${origin} show main:${file}`.nothrow().quiet().text();
const queue = (repo: string, agent: Agent, extra: Partial<Parameters<typeof runQueue>[0]> = {}) =>
  runQueue({ cwd: repo, agent, sandbox: noSandbox(), verify: "true", merge: true, ciPollMs: 10, listRetryMs: 1, limit: 5, ...extra });

describe("runQueue() with parallel", () => {
  test("different files: both merged in queue order, the second updated onto the first", async () => {
    const { repo, root, origin } = await setup([1, 2]);
    // Issue 1 is slower, yet must merge first.
    const agent = fakeAgent(root, (n) => `echo ${n} > file${n}.txt`, { 1: [2] });
    const rs = await queue(repo, agent, { parallel: 2 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [2, "merged"]]);
    expect((await Bun.file(join(root, "merge-order.log")).text()).trim().split("\n")).toEqual(["feature/1-issue-1", "feature/2-issue-2"]);
    expect(await show(origin, "file1.txt")).toBe("1\n");
    expect(await show(origin, "file2.txt")).toBe("2\n");
  });

  test("slots don't read the repo's shared FETCH_HEAD, which another slot's fetch can rewrite", async () => {
    const { repo, root, origin } = await setup([1, 2]);
    // Every fetch is immediately followed by a FETCH_HEAD rewrite, as when another slot's fetch lands in between.
    const git = Bun.which("git", { PATH: origPath })!;
    await Bun.write(join(root, "bin", "git"), `#!/bin/sh\n"${git}" "$@"; rc=$?\ncase " $* " in *" fetch "*) rm -f "${repo}/.git/FETCH_HEAD";; esac\nexit $rc\n`);
    await chmod(join(root, "bin", "git"), 0o755);
    const rs = await queue(repo, fakeAgent(root, (n) => `echo ${n} > file${n}.txt`), { parallel: 2 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [2, "merged"]]);
    expect(await show(origin, "file1.txt")).toBe("1\n");
    expect(await show(origin, "file2.txt")).toBe("2\n");
  });

  test("slots never run worktree add/remove or branch -D at the same time (git reads each other's half-made worktrees)", async () => {
    const { repo, root, origin } = await setup([1, 2]);
    // Holds each such command open long enough that two slots' would overlap, and fails the command if they do.
    const git = Bun.which("git", { PATH: origPath })!;
    const lock = join(root, "admin.lock");
    await Bun.write(
      join(root, "bin", "git"),
      `#!/bin/sh
case " $* " in
  *" worktree add "*|*" worktree remove "*|*" branch -D "*)
    mkdir "${lock}" 2>/dev/null || { echo "overlapping worktree admin: $*" >&2; exit 1; }
    sleep 0.5; "${git}" "$@"; rc=$?; rmdir "${lock}"; exit $rc;;
esac
exec "${git}" "$@"
`,
    );
    await chmod(join(root, "bin", "git"), 0o755);
    const rs = await queue(repo, fakeAgent(root, (n) => `echo ${n} > file${n}.txt`), { parallel: 2 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [2, "merged"]]);
    expect(await show(origin, "file1.txt")).toBe("1\n");
    expect(await show(origin, "file2.txt")).toBe("2\n");
  });

  test("runs the agents concurrently", async () => {
    const { repo, root } = await setup([1, 2]);
    // Each agent waits for the other to have started: sequential agents would hit the barrier cap and fail.
    const agent = fakeAgent(root, (n) => `echo ${n} > file${n}.txt`, {}, [1, 2]);
    const rs = await queue(repo, agent, { parallel: 2 });
    expect(rs.map((r) => r.status)).toEqual(["merged", "merged"]);
  });

  test("same lines: the second conflicts and is retried once from the new main", async () => {
    const { repo, root, origin } = await setup([1, 2]);
    const agent = fakeAgent(root, (n, attempt) => (n === 2 && attempt > 1 ? `echo "2 again" > other.txt` : `echo ${n} > shared.txt`), { 1: [2] });
    const rs = await queue(repo, agent, { parallel: 2 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [2, "merged"]]);
    expect(rs[1]!.branch).not.toBe("feature/2-issue-2");
    expect(await show(origin, "shared.txt")).toBe("1\n");
    expect(await show(origin, "other.txt")).toBe("2 again\n");
  });

  test("verify failing after the update: one retry, then the normal failure", async () => {
    const { repo, root, origin } = await setup([1, 2]);
    // Each passes alone; together they fail.
    const verify = "! (test -f a.txt && test -f b.txt)";
    const agent = fakeAgent(root, (n) => (n === 1 ? "echo a > a.txt" : "echo b > b.txt"), { 1: [2] });
    const rs = await queue(repo, agent, { parallel: 2, verify });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [2, "verify-failed"]]);
    expect(await show(origin, "b.txt")).toBe("");
  });

  test("a verify failure before the update is not retried", async () => {
    const { repo, root } = await setup([1, 2]);
    let runs = 0;
    const agent = fakeAgent(root, (n) => (runs++, `echo ${n} > file${n}.txt`));
    const rs = await queue(repo, agent, { parallel: 2, verify: "false", keepGoing: true });
    expect(rs.map((r) => r.status)).toEqual(["verify-failed", "verify-failed"]);
    expect(runs).toBe(2);
  });

  test("limit counts concurrent issues", async () => {
    const { repo, root } = await setup([1, 2]);
    const rs = await queue(repo, fakeAgent(root, (n) => `echo ${n} > file${n}.txt`), { parallel: 2, limit: 1 });
    expect(rs.map((r) => r.issue)).toEqual([1]);
  });

  test("parallel 1 is the sequential queue: no update step, the branch is pushed as is", async () => {
    const { repo, root } = await setup([1, 2]);
    const rs = await queue(repo, fakeAgent(root, (n) => `echo ${n} > file${n}.txt`), { parallel: 1 });
    expect(rs.map((r) => [r.issue, r.status])).toEqual([[1, "merged"], [2, "merged"]]);
    expect((await Bun.file(join(root, "merge-order.log")).text()).trim().split("\n")).toEqual(["feature/1-issue-1", "feature/2-issue-2"]);
  });
});
