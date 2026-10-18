# Concepts

## Worktree per issue

Each issue gets its own git worktree at `<repo>/.worktrees/<N>-<slug>` on a branch `fix/<N>-<slug>` (issue labelled `bug`) or `feature/<N>-<slug>`, created from freshly fetched origin. Your checkout and branch are never touched. `.worktrees/` is excluded via `.git/info/exclude`. Worktrees are removed after a merge and kept when a run fails, so you can inspect them. Leftovers pile up (interrupted runs, merged or closed issues): `bunker clean` lists them (a dry run), `bunker clean --yes` removes them; `--logs <days>` also prunes old run logs and `--images` unused `bunker-repo-*` images. Work not on origin's default branch is first kept under a `bunker/stale/<name>-<timestamp>` tag, and only bunker's own names are touched. `bunker issue`, `bunker queue` and `bunker watch` run the same worktree and branch cleanup at start-up, and Ctrl-C removes the current run's empty `/tmp/bunker-*` worktree and branch. `clean` exits 2 while a `bunker watch` for the repo is running, unless `--force`.

## Docker sandbox and images

The agent runs in a throwaway docker container with the worktree (and the repo's `.git`, mounted at its host path) as the working directory. The container runs as your uid, and holds the Claude token but no GitHub credentials. `--no-sandbox` runs the agent on the host instead.

Images come in two layers:

- **Base** `bunker-claude`: debian trixie-slim with git, bash, ripgrep and the `claude` binary. Built automatically on first use. It has no Python, Node or Bun.
- **Per repo** `.bunker/Dockerfile`: if present, bunker builds it (layer-cached) and runs the agent there. It starts `FROM bunker-claude` and adds whatever the repo needs to run its tests. `--image <name>` uses an image as-is.

## Implement, review, fix

An implementer agent works from the issue (title, body and trusted comments). A reviewer agent then sees the full diff and either approves or lists required changes. Anything the reviewer changes is discarded. On changes requested, the implementer runs again with the feedback. This repeats for up to `--max-rounds` rounds (default 2). Not approved: nothing is pushed. The implementer resumes its own Claude session each round (the feedback is the new prompt) and across `--max-iterations`; reviewers always start fresh, and `--no-resume` turns it off. Session files are kept in `.bunker/sessions/<issue>/` (gitignored; `*.redacted.jsonl` copies for sharing). If a resume fails, bunker falls back to a fresh session.

### Forking a session (library)

`run()` returns a result with `fork(prompt, opts?)`: it starts a new run (own branch, own worktree) that continues from the parent run's last Claude session. Claude is asked to resume that session as a fork, so the child gets a new session id and the parent session is unchanged; fork the same result as often as you like, e.g. one expensive "read the codebase and plan" run followed by several children. `opts` override the parent's run options. Unlike a normal resume there is no fresh-session fallback: if the fork cannot start, the child fails. `fork` throws if the parent reported no session. Agents implement it through `Agent.command(prompt, mode, { fork: sessionId })`.

## Prompt templates

The prompt for an issue comes from a template. A repo overrides the built-in one with `.bunker/prompts/issue.md` (read from the worktree, so it is whatever the base commit has). Two things are expanded, in one pass over the template:

- `{{KEY}}` is replaced by a value. Built-ins: `ISSUE_NUMBER`, `ISSUE_TITLE`, `BRANCH`, `REPO`, `BASE`, plus `ISSUE` (the fenced issue title and body), `COMMENTS` (trusted comments) and `CONVENTION` (the follow-up reporting instructions). An unknown key is an error and fails the run.
- `` !`cmd` `` is replaced by the output of `cmd`, run with bash on the host, in the worktree, with a 30 second timeout. It gets the isolated env: no GitHub or Claude tokens. A command that fails or times out fails the run.

Only the template is ever expanded. Issue text and comments are substituted as values after the template is scanned and are never re-expanded, and command output is not re-expanded either, so `{{X}}` or `` !`id` `` in an issue stays literal. Commands run only from repo-owned prompt files, never from issue text or agent output. Treat `.bunker/prompts/` like `.bunker/setup`: it runs code on your host.

## Verify in the sandbox

After approval, `.bunker/verify` (or `--verify "<cmd>"`) runs in the worktree inside the sandbox, after `.bunker/setup`. A failure stops the run before anything is pushed. `--verify-on-host` opts out; see [security.md](security.md).

## PR, auto-merge and the landing check

bunker pushes the branch and opens a PR with `Closes #N`. With `--merge` it first reads the default branch's repository rulesets and refuses (`merge-failed`) unless a required status check is set (or if the lookup fails), because without one GitHub merges at once. Then it asks GitHub for auto-merge (squash), so GitHub merges once the required checks pass. bunker never reads CI itself. It polls the PR until it is merged or closed, or `--ci-timeout` minutes pass. After the merge it checks that the files the branch changed are identical on `origin/<default>` and the branch tip (the landing check), then cleans up.

Under `bunker watch` the run ends as soon as the PR is open and auto-merge is armed (`awaiting-merge`), which frees its `--parallel` slot; the shepherd (below) then waits for the merge, so the wait survives a restart, and `--ci-timeout` is not used. With `bunker issue`/`bunker queue --merge` and no watcher, the run still waits itself.

Outcomes: `idle-timeout` (an agent went quiet, or setup/verify ran too long; worktree and branch kept), `merged`, `ci-timeout` (PR left open, auto-merge still armed), `merge-failed`, `merge-unverified` (merged, but files differ on the default branch), plus `rejected`, `failed`, `conflict`, `verify-failed` and `pr-opened` (no `--merge`).

## Labels

- `bunker:queued`: queued, and the maintainer-only gate. `bunker queue` and `bunker watch` work these in this order: `priority:high`, `priority:medium`, no priority label, `priority:low`; within the same priority, issues labelled `bug` first; then oldest first. Open `Blocked by #N` / `Depends on #N` skips apply regardless of priority. Each pass prints the order with the reason per issue (`queue: #160 (high, bug) · #131 · #132 (low)`), in the run log and in `--ui`; under `bunker watch` the order is re-evaluated between issues, so a newly labelled bug or `priority:high` issue runs next. The `priority:*` labels (red, orange, grey) are created if missing and checked by `bunker doctor` / `bunker init`. A human sets priority when triaging: agent-filed (`discovered`) issues never get one, though an agent can mark a follow-up `"bug": true` in its report to file it with the `bug` label.
- `discovered`: filed by an agent (or `bunker audit`) for something out of scope. It waits for a human to triage; relabel it `bunker:queued` to queue it. Agents can't queue work themselves. Each run files at most one follow-up, only `high` or `medium`, labelled `severity:high` or `severity:medium` (never `priority:*`); the rest are listed as "not filed" in the run log and PR body. `bunker audit` files only high/medium too, up to `--max-issues`.
- `bunker:in-progress`: bunker is working on the issue. Set when a run starts (which also removes `bunker:failed`), removed when it ends; a `bunker watch` start also removes it from issues with no live run (crash recovery).
- `bunker:failed`: `bunker watch` swaps `bunker:queued` for this when an issue ends in anything but `merged`, and comments the status and log path. It is never retried automatically; a maintainer re-adds `bunker:queued` to retry (that is the approval the gate checks, so there is no `bunker:retry`).
- `bunker:review`: on a PR; it is green but waits for a human (it touches `.bunker/` or `.github/`), so bunker left auto-merge off.
- `bunker:awaiting-review`: on a PR in manual-merge mode (see below); bunker keeps it green but never merges it.
- `bunker-blocked`: an agent reported a `blocked_by` item (`{"title","body"}`, in its final `<report>` or the reviewer's `<verdict>` JSON) because the issue can't be done until something else is. bunker files that blocker as `discovered` (body ends `Blocks #N.`; a human triages it), pushes nothing, removes the worktree and branch, comments `Blocked by #M: <title>` and swaps `bunker:queued` for this label. The result status is `blocked`; it doesn't count toward `--limit` and doesn't stop the queue or `bunker watch`. The queue also skips any issue whose body or trusted comments say `Blocked by #N` or `Depends on #N` while #N is open (logged as `waiting on #N`). At the start of each queue pass and after each merge, every open `bunker-blocked` issue whose blockers are all closed goes back to `bunker:queued` with the comment `Unblocked: #M is closed`.

## Run logs

Every issue run writes a redacted log to `<repo>/.bunker/runs/<N>-<timestamp>.log` with agent, setup and verify output. The terminal is quiet by default: stage lines, one live progress line on a TTY, and a summary per step. On a failure the last 40 lines and the log path are shown. `--verbose` (or `BUNKER_VERBOSE=1`) streams everything.

## Live view

`bunker ui` serves a page on `127.0.0.1:4321` with one tab per repo: stage, round, time, cost, PR link and feed per issue. Runs publish to it automatically when it is reachable; `--ui` starts one for the run if none is up. See [security.md](security.md).

## Parallel queue

`bunker queue` is sequential by default: two PRs that are each green against an old main can break main together. `--parallel <n>` (with `--merge`, or under `bunker watch`) works up to n issues at once, each in its own worktree and container, but keeps merges safe: they happen one at a time in queue order, and before a PR is created bunker merges the latest `origin/<default>` into its branch and re-runs verify in the sandbox. A conflict, or verify failing on the updated branch, gets one fresh attempt of that issue from the new main (a new branch, `-2` suffix); a second failure is handled like any other (`bunker:failed` under `bunker watch`). `--limit` and the `bunker watch` spend cap count all concurrent work, though cost is only recorded when an issue finishes, so a cap can be overshot by the issues already in flight. The trade-off is more concurrent spend and rework when issues touch the same files; 2 is recommended. Also consider requiring branches to be up to date in the repo's branch protection as a backstop.

## The PR shepherd

`bunker watch` runs a shepherd stage on every pass, and `bunker shepherd` runs one pass by hand. It owns every open bunker PR (same-repo branch `feature|fix/<n>-…` whose body says `Closes #<n>`) until GitHub merges it or a human is needed, and keeps no state: everything comes from GitHub, so a restarted watcher carries on. For each PR:

- a **red required check**: the failed job's log goes to a fix agent in a worktree of the PR branch; after setup and verify pass the fix is pushed. At most 3 attempts (counted from hidden markers in the PR's comments), then the PR and its issue get `bunker:failed`, a comment and a notification. Reading the log needs Actions: Read on the token; without it the PR is handed to a human the same way;
- **behind** its base: the branch is updated through GitHub;
- a **conflict**: an agent merges the base into the branch in the PR's worktree and resolves it, verify runs, and if the diff changed a reviewer checks it again before the push;
- a **"changes requested" review** from the owner or an admin/maintainer: the review and its inline comments go to the agent, the result is pushed and the review is re-requested.

The shepherd never merges. PRs labelled `bunker:failed` or `bunker:review`, and drafts, are left alone; removing `bunker:failed` gives a PR a fresh set of attempts.

## Manual-merge mode

For repos without auto-merge, or when you want to check each PR: `merge = "manual"` in `.bunker/config.toml` (or `[merge] mode = "manual"`), or `bunker watch --no-merge`. A run then ends at an open PR labelled `bunker:awaiting-review`, with a notification; auto-merge is never requested. The queue skips issues that already have an open bunker PR, and the shepherd keeps the waiting PRs green and up to date but never merges them. `--parallel` above 1 is allowed: PRs that stack up are brought up to date (or their conflicts resolved) by the shepherd. With a separate bot identity for bunker and a required approval on the default branch, you do not need manual mode: approve the PR and auto-merge does the rest.

Labels only display state. Decisions come from GitHub events (who added `bunker:queued`), `watch.lock`, worktrees and PR state, so a `bunker:in-progress`, `bunker:failed` or `bunker:review` label added by anyone never queues work.

### Migrating from the old label names

The old `bunker`, `bunker-failed` and `needs-human-review` labels are no longer read or written; only `bunker:queued` queues work. `bunker doctor` and `bunker init` report any of them still on the repo, with the rename to run, and report the new labels as ✗ until they exist. To rename existing labels and keep them on existing issues and PRs:

```sh
gh label edit bunker --name bunker:queued
gh label edit bunker-failed --name bunker:failed
gh label edit needs-human-review --name bunker:review
gh label create bunker:in-progress
```

## Context files

`context = ["docs/spec.md", "docs/architecture.md"]` in `.bunker/config.toml` inlines those files into the implementer and reviewer prompts (the reviewer checks the change against them). A `Spec: <path>` line in an issue body (author with admin/maintain permission) or trusted comment adds a file for that issue. Files are read from origin's default branch with `git show`, never the worktree, and inserted as fenced, labelled values, never template-expanded. Each file and the total are capped at 50 KB; a missing or oversized file fails the run, naming it.

## Library API

Embedders import from `src/index.ts`. This is the stable surface for 1.0; everything else is internal and may change without notice.

- Pipelines: `run`, `runAll`, `review`, with their option and result types (`RunOptions`, `RunAllOptions`, `RunResult`, `TaskResult`, `Iteration`, `ReviewOptions`, `ReviewResult`, `ReviewRound`, `Commit`)
- Agents: `claudeCode`, and the `Agent`, `AgentMode` and `Usage` types
- Sandboxes: `docker`, `podman`, `noSandbox`, and the `Sandbox`, `DockerOptions`, `ExecContext`, `ExecLimits`, `ExecResult` and `Timeouts` types
- Events: the `BunkerEvent`, `EventTarget` and `OnEvent` types
- Errors: `AgentFailure`, `UsageLimit`, and the `Pause` type

The export list is pinned by `test/public-api.test.ts`.
