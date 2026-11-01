# Concepts

## Worktree per issue

Each issue gets its own git worktree at `<repo>/.worktrees/<N>-<slug>` on a branch `fix/<N>-<slug>` (issue labelled `bug`) or `feature/<N>-<slug>`, created from freshly fetched origin. Your checkout and branch are never touched. `.worktrees/` is excluded via `.git/info/exclude`. Worktrees are removed after a merge and kept when a run fails, so you can inspect them. Sessions (`.bunker/sessions/<issue>/`) are removed once their issue closes, and logs older than `clean.logs_days` (default 30) are pruned at start-up. Leftovers pile up (interrupted runs, merged or closed issues): `bunker clean` lists them (a dry run), `bunker clean --yes` removes them; `--logs <days>` also prunes old run logs and `--images` unused `bunker-repo-*` images. Work not on origin's default branch is first kept under a `bunker/stale/<name>-<timestamp>` tag, and only bunker's own names are touched. `bunker issue`, `bunker queue` and `bunker watch` run the same worktree and branch cleanup at start-up, and Ctrl-C removes the current run's empty `/tmp/bunker-*` worktree and branch. `clean` exits 2 while a `bunker watch` for the repo is running, unless `--force`.

## Docker sandbox and images

The agent runs in a throwaway docker container with the worktree (and the repo's `.git`, mounted at its host path) as the working directory. The container runs as your uid, and holds the Claude token but no GitHub credentials. Agent steps run on a dedicated `bunker-agent` bridge network (not `--network host`), so they can't reach services on the host's localhost (see [security.md](security.md)). Isolated steps (verify and `check`, by default) run with no network. `--no-sandbox` runs the agent on the host instead.

Images come in two layers:

- **Base** `bunker-claude`: debian trixie-slim with git, bash, ripgrep and the `claude` binary. Built automatically on first use. It has no Python, Node or Bun.
- **Per repo** `.bunker/Dockerfile`: if present, bunker builds it (layer-cached) and runs the agent there. It starts `FROM bunker-claude` and adds whatever the repo needs to run its tests. `--image <name>` uses an image as-is.

## Implement, review, fix

An implementer agent works from the issue (title, body and trusted comments). A reviewer agent then sees the full diff and either approves or lists required changes. Anything the reviewer changes is discarded. On changes requested, the implementer runs again with the feedback. This repeats for up to `--max-rounds` rounds (default 2). Not approved: nothing is pushed. If `check` is set in `config.toml` (e.g. a typecheck), it runs isolated before each review and its output goes into the reviewer prompt. The implementer resumes its own Claude session each round (the feedback is the new prompt) and across `--max-iterations`; reviewers always start fresh, and `--no-resume` turns it off. Session files are kept in `.bunker/sessions/<issue>/` (gitignored; `*.redacted.jsonl` copies for sharing) until the issue closes. If a resume fails, bunker falls back to a fresh session.

### Forking a session (library)

`run()` returns a result with `fork(prompt, opts?)`: it starts a new run (own branch, own worktree) that continues from the parent run's last Claude session. Claude is asked to resume that session as a fork, so the child gets a new session id and the parent session is unchanged; fork the same result as often as you like, e.g. one expensive "read the codebase and plan" run followed by several children. `opts` override the parent's run options. Unlike a normal resume there is no fresh-session fallback: if the fork cannot start, the child fails. `fork` throws if the parent reported no session. Agents implement it through `Agent.command(prompt, mode, { fork: sessionId })`.

## Prompt templates

The prompt for an issue comes from a template. A repo overrides the built-in one with `.bunker/prompts/issue.md` (read from origin's default branch, never the worktree). Two things are expanded, in one pass over the template:

- `{{KEY}}` is replaced by a value. Built-ins: `ISSUE_NUMBER`, `ISSUE_TITLE`, `BRANCH`, `REPO`, `BASE`, plus `ISSUE` (the fenced issue title and body), `COMMENTS` (trusted comments) and `CONVENTION` (the follow-up reporting instructions). An unknown key is an error and fails the run.
- `` !`cmd` `` is replaced by the output of `cmd`, run with bash on the host, in the worktree, with a 30 second timeout. It gets the isolated env: no GitHub or Claude tokens. A command that fails or times out fails the run.

Only the template is ever expanded. Issue text and comments are substituted as values after the template is scanned and are never re-expanded, and command output is not re-expanded either, so `{{X}}` or `` !`id` `` in an issue stays literal. Commands run only from repo-owned prompt files, never from issue text or agent output. Treat `.bunker/prompts/` like `setup` in `.bunker/config.toml`: it runs code on your host.

## Verify in the sandbox

After approval, `verify` from `.bunker/config.toml` (or `--verify "<cmd>"`) runs in the worktree inside the sandbox, after `setup`. A failure first gets a fix round: the implementer gets the output and tries again, up to `verify_retries` times (default 1; 0 turns it off), and verify then runs again. If it still fails the run ends as `verify-failed` before anything is pushed. `--verify-on-host` opts out; see [security.md](security.md).

### Services for verify (databases)

Tests that need Postgres, Redis or the like can declare them in `.bunker/config.toml`:

```toml
prepare = "bin/console doctrine:migrations:migrate -n && bin/console doctrine:fixtures:load -n"

[services.database]
image = "postgres:18-alpine"
healthcheck = "pg_isready -U app"
[services.database.env]
POSTGRES_USER = "app"
POSTGRES_PASSWORD = "app"
```

For each verify attempt bunker creates an internal network with no route out, starts every service on it under its declared name (`database` here, so `.env.test` can point at host `database`), waits for each `healthcheck` to exit 0, runs `prepare` and then `verify` in the sandbox on that network, and removes the containers and the network afterwards, also when `prepare` or `verify` fails, times out, or a service never gets healthy. Names are unique per attempt, so each run gets fresh, throwaway state and parallel runs share no database. A service that won't start or become healthy fails the run before verify. Services and `prepare` come from the default branch like `verify`, need the docker or podman sandbox, and exclude `--verify-on-host`. `bunker doctor` lists them and checks the images can be pulled; `bunker init` mentions them.

Security trade-off: verify runs code the agent wrote, and now that code can reach the services. It still has no route to the internet or the host (`verify_network` does not change that while services are declared: it only passes the credentials through), but it can read and write anything in the databases and use whatever the images allow. Use throwaway credentials, no real data, and images you trust. A healthcheck such as `pg_isready` can pass against the image's temporary init server, so prefer one that runs a real query. The images themselves are pulled by the Docker daemon, outside the sandbox.

## PR, auto-merge and the landing check

bunker pushes the branch and opens a PR with `Closes #N`. With `--merge` it first reads the default branch's repository rulesets and refuses (`merge-failed`) unless a required status check is set (or if the lookup fails), because without one GitHub merges at once. Then it asks GitHub for auto-merge (squash), so GitHub merges once the required checks pass. With `--merge` the run itself does not read CI; it polls the PR until it is merged or closed, or `--ci-timeout` minutes pass. After the merge it checks that the files the branch changed are identical on `origin/<default>` and the branch tip (the landing check), then cleans up.

Under `bunker watch` the run ends as soon as the PR is open and auto-merge is armed (`awaiting-merge`), which frees its `--parallel` slot; the shepherd (below) then waits for the merge, so the wait survives a restart, and `--ci-timeout` is not used. With `bunker issue`/`bunker queue --merge` and no watcher, the run still waits itself.

Under `bunker watch` the shepherd does read CI: the required checks, and the logs of failed jobs (see below).

Outcomes: `idle-timeout` (an agent went quiet, or setup/verify ran too long; worktree and branch kept), `merged`, `ci-timeout` (PR left open, auto-merge still armed), `merge-failed`, `merge-unverified` (merged, but part of the PR's own added lines is missing from the default branch; the hunks are named, and the issue is not offered for re-queueing), plus `rejected`, `failed`, `conflict`, `verify-failed`, `bad-output` (an agent's report couldn't be parsed), `blocked`, `already-in-progress`, `paused-usage-limit` (usage limit hit; resumes later), `needs-review` (a human must review the PR), `awaiting-merge` (auto-merge armed under `bunker watch`), `awaiting-review` (manual-merge mode), `pr-opened` (no `--merge`) and `no-change` (the agent found nothing to change, the reviewer agreed after checking the verdict and its evidence against the default branch, and bunker closed the issue with an explained comment; reopen it and re-add `bunker:queued` to disagree).

## Labels

- `bunker:queued`: queued, and the maintainer-only gate. `bunker queue` and `bunker watch` work these in this order: `priority:high`, `priority:medium`, no priority label, `priority:low`; within the same priority, issues labelled `bug` first; then oldest first. Open `Blocked by #N` / `Depends on #N` skips apply regardless of priority. Each pass prints the order with the reason per issue (`queue: #160 (high, bug) · #131 · #132 (low)`), in the run log and in `--ui`; under `bunker watch` the order is re-evaluated between issues, so a newly labelled bug or `priority:high` issue runs next. The `priority:*` labels (red, orange, grey) are created if missing and checked by `bunker doctor` / `bunker init`. A human sets priority when triaging: agent-filed (`discovered`) issues never get one, though an agent can mark a follow-up `"bug": true` in its report to file it with the `bug` label.
- `discovered`: filed by an agent (or `bunker audit`) for something out of scope. It waits for a human to triage; relabel it `bunker:queued` to queue it. Agents can't queue work themselves. Each run files at most one follow-up, only `high` or `medium`, labelled `severity:high` or `severity:medium` (never `priority:*`); the rest are listed as "not filed" in the run log and PR body. `bunker audit` files only high/medium too, up to `--max-issues`.
- `bunker:in-progress`: bunker is working on the issue. Set when a run starts (which also removes `bunker:failed`), removed when it ends; a `bunker watch` start also removes it from issues with no live run (crash recovery).
- `bunker:failed`: `bunker watch` swaps `bunker:queued` for this when an issue ends in anything but `merged`, and comments the status and log path. It is never retried automatically; a maintainer re-adds `bunker:queued` to retry (that is the approval the gate checks, so there is no `bunker:retry`).
- `bunker:review`: on a PR; it is green but waits for a human (it touches `.bunker/`, `.github/`, an agent-steering file, `package.json`, a lockfile, a `Makefile` or a `review_paths` glob from `.bunker/config.toml`), so bunker left auto-merge off.
- `bunker:awaiting-review`: on a PR in manual-merge mode (see below); bunker keeps it green but never merges it.
- `bunker:exclude`: never for bunker; the queue, `watch`, `triage` and the MCP `queue_issue` refuse the issue, even if also `bunker:queued`. **Label tracking issues (an epic whose body is a checklist of other issues) `bunker:exclude`.** Without it, the queue still skips an issue whose task list consists only of `- [ ] #N` references (`skipped #N: tracking issue`, with one comment), unless it carries `bunker:force`.
- `bunker:force`: overrides the tracking-issue refusal; bunker implements the issue despite its task list of issue references. It does not override `bunker:exclude`.
- `bunker-blocked`: an agent reported a `blocked_by` item (`{"title","body"}`, in its final `<report>` or the reviewer's `<verdict>` JSON) because the issue can't be done until something else is. bunker files that blocker as `discovered` (body ends `Blocks #N.`; a human triages it), pushes nothing, removes the worktree and branch, comments `Blocked by #M: <title>` and swaps `bunker:queued` for this label. The result status is `blocked`; it doesn't count toward `--limit` and doesn't stop the queue or `bunker watch`. The queue also skips any issue whose body or trusted comments say `Blocked by #N` or `Depends on #N` while #N is open (logged as `waiting on #N`). At the start of each queue pass and after each merge, every open `bunker-blocked` issue whose blockers are all closed goes back to `bunker:queued` with the comment `Unblocked: #M is closed`.

## Run logs

Every issue run writes a redacted log to `<repo>/.bunker/runs/<N>-<timestamp>.log` with agent, setup and verify output. The terminal is quiet by default: stage lines, one live progress line on a TTY, and a summary per step. On a failure the last 40 lines and the log path are shown. `--verbose` (or `BUNKER_VERBOSE=1`) streams everything.

## Live view (`bunker ui`)

One hub per machine serves the live view on `127.0.0.1:4321`. Every watcher started with `--ui` publishes to it; the first one starts the hub and the others find it. Runs also publish when a hub is already reachable. The page has one tab per repo (a status dot and a count such as "2 running" or "idle"), and each tab groups runs by state:
- **Running**: one card per run with the stage track (setup, implement, review, verify, PR; an audit has setup, audit, filing), round, time, cost, PR link and a feed.
- **Waiting for merge**: PRs with auto-merge armed, with the CI state the shepherd last reported.
- **Finished today**: merged, failed and audit runs. An audit card lists the issues it filed.

A sidebar shows the **Queue** (next up, and issues waiting on a blocker), the **Shepherd** (open bunker PRs and the last action on each) and the **Watcher** (version, uptime, parallelism, time to the next pass). When nothing is queued or running, an idle panel shows the next pass, spend today, merges today and the last merge. A spend card shows today and the last 30 days against the cap in effect, with a warning from 80% and a pause notice when the cap is reached. Every issue and PR reference is a link.

The view is read-only. The URL carries an access key (`?k=...`) that the page and its socket need; `bunker ui` and `--ui` print it. See [security.md](security.md).

### History

The hub keeps each repo's events in `$XDG_STATE_HOME/bunker/hub/<owner>_<repo>.jsonl` (default `~/.local/state/bunker/hub/`) and replays them when it starts, so the view survives a restart. It keeps at most 2000 events per repo and 7 days; older events are dropped when the hub starts. To clear one repo, delete its file and restart the hub (a running hub still holds the events in memory).

## Parallel queue

`bunker queue` is sequential by default: two PRs that are each green against an old main can break main together. `--parallel <n>` (with `--merge`, or under `bunker watch`) works up to n issues at once, each in its own worktree and container, but keeps merges safe: they happen one at a time in queue order, and before a PR is created bunker merges the latest `origin/<default>` into its branch and re-runs verify in the sandbox. A conflict, or verify failing on the updated branch, gets one fresh attempt of that issue from the new main (a new branch, `-2` suffix); a second failure is handled like any other (`bunker:failed` under `bunker watch`). `--limit` and the `bunker watch` spend cap count all concurrent work, though cost is only recorded when an issue finishes, so a cap can be overshot by the issues already in flight. The trade-off is more concurrent spend and rework when issues touch the same files; 2 is recommended. Also consider requiring branches to be up to date in the repo's branch protection as a backstop.

## The PR shepherd

`bunker watch` runs a shepherd stage on every pass, and `bunker shepherd` runs one pass by hand. It owns every open bunker PR (same-repo branch `feature|fix/<n>-…` whose body says `Closes #<n>`) until GitHub merges it or a human is needed, and keeps no state: everything comes from GitHub, so a restarted watcher carries on. For each PR:

- a **red required check**: the failed job's log goes to a fix agent in a worktree of the PR branch; after setup and verify pass the fix is pushed. At most 3 attempts (counted from hidden markers in the PR's comments), then the PR and its issue get `bunker:failed`, a comment and a notification. CI is read from the Actions runs and jobs of the PR's head commit plus its commit statuses (Actions: Read on the token; a fine-grained token cannot read check runs), and a required context with no run yet counts as pending. Without Actions: Read the PR is handed to a human the same way;
- **behind** its base: the branch is updated through GitHub;
- a **conflict**: an agent merges the base into the branch in the PR's worktree and resolves it (also at most 3 attempts), verify runs, and if the diff changed a reviewer checks it again before the push;
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

## Is this a good fit for bunker?

The test: can the whole job be written down in the issue before anyone starts? If yes, queue it. If the work only takes shape while you're doing it, do it by hand.

**Do it by hand when one of these is true:**

1. **Decisions get made mid-task.** Wording, UX, "what should this do", or any question you'd want answered halfway through. The agent can't ask, so it guesses.
2. **The tests can't tell if it's right.** The proof is real data, a real browser, header or CSP behaviour, or a production deploy. A green run is only as good as the suite.
3. **It needs access bunker deliberately doesn't have.** Secrets, deploy or production systems, merges, or changes to `.bunker/` and CI config.
4. **It's security- or money-sensitive.** Auth, authz or payments auto-merge unless the path is covered by `review_paths`, so add a glob first or do it by hand (see [security.md](security.md)).
5. **It's an investigation** ("why is X wrong"), not a change.
6. **It's urgent**, such as a hotfix where the queue is slower than doing it.

**Queue it when:**

- the issue fits in a few lines with checkable acceptance criteria,
- it's contained (roughly 1-3 files), and
- the existing tests would catch it if it went wrong.

**Making a borderline issue fit:** move the decisions into the issue. Spell out the exact wording, edge-case rules (for example "don't resend on re-approve") and the tests you expect. Then the agent is following a spec, not guessing at intent.
