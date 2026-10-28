import { liveGhEnv } from "../../github/identity.ts";
import { $ } from "bun";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { alive } from "./watch.ts";
import { defaultBranchOf } from "../../github/pull.ts";
import { stamp } from "../../github/branches.ts";
import { clearInProgress, IN_PROGRESS_LABEL } from "../../github/labels.ts";
import { worktreeAdmin } from "../../worktree/admin.ts";

export interface CleanOptions {
  cwd: string;
  /** Really remove; without it nothing is changed and the plan is printed. */
  yes?: boolean;
  /** Also remove `.bunker/runs/*.log` older than this many days (not those of a running or paused issue). */
  logsDays?: number;
  /** Also remove `bunker-repo-*` docker images no running container uses. */
  images?: boolean;
  /** Go ahead although a `bunker watch` lock is held by a live process. */
  force?: boolean;
  /** Start-up cleanup: worktrees, branches, old logs and closed issues' sessions only, quiet, and a no-op rather than an error when it can't run. */
  auto?: boolean;
  log?: (line: string) => void;
}

export interface CleanResult {
  /** 0 done (or dry run), 1 something could not be removed, 2 refused. */
  code: number;
  /** `bunker/stale/*` tags made (or, in a dry run, that would be). */
  tags: string[];
}

interface Wt {
  path: string;
  head: string;
  branch?: string;
}

const RUN_BRANCH = /^bunker\/[0-9a-f]{8}$/;
const ISSUE_BRANCH = /^(?:feature|fix)\/\d+-[a-z0-9-]*$/;

/** Whether any running process has `path` as (or under) its cwd or on its command line (e.g. a docker -v mount). Unknown counts as in use. */
function inUse(path: string): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return true;
  }
  for (const pid of pids) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === path || cwd.startsWith(path + sep)) return true;
    } catch {}
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(path)) return true;
    } catch {}
  }
  return false;
}

async function listWorktrees(repo: string): Promise<Wt[]> {
  const out = (await $`git -C ${repo} worktree list --porcelain`.nothrow().quiet()).stdout.toString();
  const list: Wt[] = [];
  for (const block of out.split("\n\n")) {
    const wt: Wt = { path: "", head: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt.path = line.slice(9);
      else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
      else if (line.startsWith("branch refs/heads/")) wt.branch = line.slice(18);
    }
    if (wt.path) list.push(wt);
  }
  return list;
}

/**
 * Removes what interrupted or finished bunker runs leave behind: `.worktrees/<n>-*` of closed issues or PRs,
 * unused `/tmp/bunker-*` worktrees, `bunker/<id>` branches without a worktree, spent issue branches. Anything with
 * commits not on origin's default branch, or uncommitted changes, is first kept under a `bunker/stale/<name>-<timestamp>` tag.
 */
export async function runClean(o: CleanOptions): Promise<CleanResult> {
  const say = o.log ?? console.log;
  const note = (s: string) => say(`bunker: ${s}`);
  const stop = (s: string, code = 2): CleanResult => (o.auto ? { code: 0, tags: [] } : (note(s), { code, tags: [] }));
  const top = await $`git -C ${o.cwd} rev-parse --show-toplevel --git-dir --git-common-dir`.nothrow().quiet();
  if (top.exitCode !== 0) return stop("not a git checkout");
  const [toplevel, gitDir, commonDir] = top.stdout.toString().trim().split("\n") as [string, string, string];
  const abs = (p: string) => realpathSync(p.startsWith("/") ? p : join(o.cwd, p));
  if (abs(gitDir) !== abs(commonDir)) return stop("run clean from the repo's main checkout, not a linked worktree");
  const repo = realpathSync(toplevel);

  const lock = join(repo, ".bunker", "watch.lock");
  if (existsSync(lock) && !o.force) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      return stop(`a bunker watch is running here (pid ${pid}); stop it first, or pass --force to clean anyway`);
    }
  }

  const def = await defaultBranchOf(repo);
  const baseRef = `refs/remotes/origin/${def}`;
  if ((await $`git -C ${repo} rev-parse --verify -q ${baseRef}`.nothrow().quiet()).exitCode !== 0) return stop(`no origin/${def} to compare against; run git fetch first`);

  const env = liveGhEnv();
  const gh = async (...args: string[]): Promise<unknown> => {
    const r = await $`gh ${args}`.cwd(repo).env(env).nothrow().quiet();
    if (r.exitCode !== 0) return undefined;
    try {
      return JSON.parse(r.stdout.toString());
    } catch {
      return undefined;
    }
  };
  // Closed issue numbers, fetched once. A failed fetch means nothing counts as closed (folders are kept).
  const CLOSED_LIMIT = 1000;
  let closedSet: Set<number> | undefined;
  let closedFull = false;
  const closedIssues = async () => {
    if (!closedSet) {
      const v = await gh("issue", "list", "--state", "closed", "--json", "number,state", "--limit", String(CLOSED_LIMIT));
      const list = Array.isArray(v) ? (v as { number?: number; state?: string }[]) : [];
      // Each entry's own state decides, so an issue that is open is never counted as closed.
      closedSet = new Set(list.flatMap((i) => (typeof i.number === "number" && typeof i.state === "string" && i.state.toUpperCase() !== "OPEN" ? [i.number] : [])));
      closedFull = list.length >= CLOSED_LIMIT;
    }
    return closedSet;
  };
  const issueClosed = async (n: string) => {
    if ((await closedIssues()).has(Number(n))) return true;
    if (!closedFull) return false;
    // The list was truncated: ask about this one issue.
    const v = (await gh("issue", "view", n, "--json", "state")) as { state?: string } | undefined;
    return v?.state !== undefined && v.state.toUpperCase() !== "OPEN";
  };
  /** The PR(s) of a branch are all merged or closed (and there is at least one). */
  const prDone = async (branch: string) => {
    const v = await gh("pr", "list", "--head", branch, "--state", "all", "--json", "state");
    return Array.isArray(v) && v.length > 0 && v.every((p: { state?: string }) => String(p.state).toUpperCase() !== "OPEN");
  };

  const git = (...args: string[]) => $`git -C ${repo} ${args}`.nothrow().quiet();
  const text = async (...args: string[]) => (await git(...args)).stdout.toString().trim();
  const unique = async (ref: string) => Number(await text("rev-list", "--count", `${baseRef}..${ref}`)) || 0;

  const tagsMade: string[] = [];
  let failed = false;
  let acted = false;
  const covered = new Set<string>();
  const verb = o.yes ? "" : "would ";
  const fail = (s: string) => ((failed = true), note(s));

  /** Keep `ref`'s work (and `worktree`'s uncommitted changes) under a tag; false if that failed and the thing must stay. */
  const keep = async (name: string, ref: string, tip: string, worktree?: string): Promise<boolean> => {
    let dirty = false;
    if (worktree) {
      const st = await $`git -C ${worktree} status --porcelain`.nothrow().quiet();
      dirty = st.exitCode === 0 && st.stdout.toString().trim() !== "";
    }
    const commits = tip ? await unique(tip) : 0;
    if (!dirty && (commits === 0 || covered.has(tip))) return true;
    const tag = `bunker/stale/${name.replaceAll("/", "-")}-${stamp()}`;
    covered.add(tip);
    if (!o.yes) {
      tagsMade.push(tag);
      note(`would tag ${tag} (${dirty ? "uncommitted changes" : `${commits} unique commit(s)`})`);
      return true;
    }
    let target = tip;
    if (dirty) {
      const tmp = mkdtempSync(join(tmpdir(), "bunker-index-"));
      try {
        const e = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") } as Record<string, string>;
        const w = (...a: string[]) => $`git -C ${worktree!} ${a}`.env(e).nothrow().quiet();
        await w("read-tree", "HEAD");
        await w("add", "-A");
        const tree = (await w("write-tree")).stdout.toString().trim();
        const c = await w("-c", "user.name=bunker", "-c", "user.email=bunker@localhost", "commit-tree", tree, "-p", "HEAD", "-m", "wip: uncommitted changes from an interrupted bunker run");
        target = c.stdout.toString().trim();
        if (!tree || !target) {
          fail(`could not keep the uncommitted changes of ${name}; leaving it`);
          return false;
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const t = await git("tag", tag, target);
    if (t.exitCode !== 0) {
      fail(`could not tag ${name} as ${tag}; leaving it:\n${t.stderr}`);
      return false;
    }
    tagsMade.push(tag);
    note(`kept ${name} as tag ${tag}`);
    return true;
  };

  // Runs paused on the usage limit keep their worktree and branch for the resume.
  const pausedPaths = new Set<string>();
  const pausedBranches = new Set<string>();
  const pausedDir = join(repo, ".bunker", "paused");
  /** Issues whose logs and sessions must stay: paused, or with a worktree a process is using. */
  const busyIssues = new Set<string>();
  for (const f of existsSync(pausedDir) ? readdirSync(pausedDir).filter((f) => f.endsWith(".json")) : []) {
    busyIssues.add(f.slice(0, -5));
    try {
      const saved = JSON.parse(readFileSync(join(pausedDir, f), "utf8")) as { worktree?: string; branch?: string };
      if (saved.worktree) pausedPaths.add(existsSync(saved.worktree) ? realpathSync(saved.worktree) : saved.worktree);
      if (saved.branch) pausedBranches.add(saved.branch);
    } catch {}
  }

  // Worktrees.
  const all = (await listWorktrees(repo)).slice(1);
  const tmpRoot = realpathSync(tmpdir());
  const issueRoot = join(repo, ".worktrees");
  const removedBranches = new Set<string>();
  const gone = new Set<string>();
  for (const wt of all) {
    if (!existsSync(wt.path)) {
      gone.add(wt.path); // git worktree prune handles it
      continue;
    }
    const p = realpathSync(wt.path);
    const name = basename(p);
    if (pausedPaths.has(p)) continue;
    let reason: string | undefined;
    const isRun = dirname(p) === tmpRoot && /^bunker-[0-9a-f]{8}$/.test(name);
    const isIssue = dirname(p) === issueRoot && /^\d+-/.test(name);
    if ((isRun || isIssue) && inUse(p)) {
      if (isIssue) busyIssues.add(name.split("-")[0]!);
      if (!o.auto) note(`skipping worktree ${p}: in use by a running process`);
      continue;
    }
    if (isRun) {
      reason = "leftover run worktree no process is using";
    } else if (isIssue) {
      const n = name.split("-")[0]!;
      if (await issueClosed(n)) reason = `issue #${n} is closed`;
      else if (wt.branch && (await prDone(wt.branch))) reason = `the PR of ${wt.branch} is merged or closed`;
    }
    if (!reason) continue;
    if (!(await keep(name, wt.branch ?? "HEAD", wt.head, p))) continue;
    note(`${verb}remove worktree ${p} (${reason})`);
    acted = true;
    if (wt.branch) removedBranches.add(wt.branch);
    gone.add(wt.path);
    if (o.yes) {
      await worktreeAdmin(repo, () => $`git -C ${repo} worktree remove --force ${wt.path}`.nothrow().quiet());
      if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
    }
  }

  // Branches.
  const checkedOut = new Set<string>(["main"]);
  const current = await text("symbolic-ref", "--short", "-q", "HEAD");
  if (current) checkedOut.add(current);
  for (const wt of all) if (!gone.has(wt.path) && wt.branch) checkedOut.add(wt.branch);
  const refs = (await text("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads")).split("\n").filter(Boolean);
  for (const line of refs) {
    const [branch, sha] = line.split(" ") as [string, string];
    if (checkedOut.has(branch) || pausedBranches.has(branch) || !(RUN_BRANCH.test(branch) || ISSUE_BRANCH.test(branch))) continue;
    let reason: string | undefined;
    if (RUN_BRANCH.test(branch)) reason = "no worktree";
    else if (await prDone(branch)) reason = "its PR is merged or closed";
    else if ((await unique(sha)) === 0) reason = `no commits beyond origin/${def}`;
    if (!reason) continue;
    if (!(await keep(branch, branch, sha))) continue;
    note(`${verb}delete branch ${branch} (${reason})`);
    acted = true;
    if (o.yes) await worktreeAdmin(repo, () => $`git -C ${repo} branch -D ${branch}`.nothrow().quiet());
  }
  if (o.yes) await worktreeAdmin(repo, () => $`git -C ${repo} worktree prune`.nothrow().quiet());

  if (o.logsDays !== undefined) {
    const dir = join(repo, ".bunker", "runs");
    const cutoff = Date.now() - o.logsDays * 86_400_000;
    for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".log")) : []) {
      const file = join(dir, f);
      if (busyIssues.has(f.split("-")[0]!) || statSync(file).mtimeMs >= cutoff) continue;
      if (!o.auto) note(`${verb}remove log ${file} (older than ${o.logsDays} day(s))`);
      acted = true;
      if (o.yes) rmSync(file, { force: true });
    }
  }
  // Sessions only matter while their issue is open; a failed lookup keeps the folder.
  const sessionsDir = join(repo, ".bunker", "sessions");
  const sessionFolders = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((d) => /^\d+$/.test(d)) : [];
  if (sessionFolders.length > 0 && !o.auto) note(`checking ${sessionFolders.length} session folder(s) against closed issues...`);
  for (const n of sessionFolders) {
    if (busyIssues.has(n) || !(await issueClosed(n))) continue;
    if (!o.auto) note(`${verb}remove ${join(sessionsDir, n)} (issue #${n} is closed)`);
    acted = true;
    if (o.yes) rmSync(join(sessionsDir, n), { recursive: true, force: true });
  }

  if (!o.auto) {
    if (o.images) {
      const lines = async (...a: string[]) => {
        const r = await $`docker ${a}`.nothrow().quiet();
        return r.exitCode === 0 ? r.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean) : undefined;
      };
      const images = await lines("images", "--format", "{{.Repository}}:{{.Tag}}");
      const running = await lines("ps", "--format", "{{.Image}}");
      if (!images || !running) note("could not ask docker for images; skipping --images");
      else {
        const used = new Set(running.flatMap((i) => [i, i.includes(":") ? i : `${i}:latest`]));
        for (const img of images.filter((i) => i.startsWith("bunker-repo-") && !used.has(i))) {
          note(`${verb}remove image ${img} (no running container uses it)`);
          acted = true;
          if (o.yes) {
            const r = await $`docker rmi ${img}`.nothrow().quiet();
            if (r.exitCode !== 0) fail(`could not remove image ${img}`);
          }
        }
      }
    }
    // Per-run service networks an interrupted run left behind; docker refuses to remove one that still has containers.
    const nets = await $`docker network ls --format {{.Name}}`.nothrow().quiet();
    if (nets.exitCode === 0) {
      for (const net of nets.stdout.toString().split("\n").map((l) => l.trim()).filter((l) => l.startsWith("bunker-net-"))) {
        note(`${verb}remove network ${net} (left by an interrupted run)`);
        acted = true;
        if (o.yes) await $`docker network rm ${net}`.nothrow().quiet();
      }
    }
    if (!acted) note("nothing to clean");
    else if (!o.yes) note("dry run: nothing was changed; re-run with --yes to do this");
  }
  return { code: failed ? 1 : 0, tags: tagsMade };
}

/**
 * Crash recovery: removes `bunker:in-progress` from open issues with no live run. Live means a worktree `.worktrees/<n>-*` that a
 * process still uses (a `bunker watch` takes `watch.lock` first, so none of its own runs exist yet). Labels only display state, so a
 * failed lookup or edit leaves things as they are. Returns the issues cleared.
 */
export async function clearStaleInProgress(repo: string, env: Record<string, string>): Promise<number[]> {
  const list = await $`gh issue list --label ${IN_PROGRESS_LABEL} --state open --limit 1000 --json number`.cwd(repo).env(env).nothrow().quiet();
  if (list.exitCode !== 0) return [];
  let numbers: number[];
  try {
    numbers = (JSON.parse(list.stdout.toString()) as { number?: unknown }[]).flatMap((i) => (typeof i?.number === "number" ? [i.number] : []));
  } catch {
    return [];
  }
  const root = join(repo, ".worktrees");
  const dirs = existsSync(root) ? readdirSync(root) : [];
  const cleared: number[] = [];
  for (const n of numbers) {
    if (dirs.some((d) => d.startsWith(`${n}-`) && inUse(join(root, d)))) continue;
    await clearInProgress(n, repo, env);
    cleared.push(n);
  }
  return cleared;
}
