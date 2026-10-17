# Concepts

## Worktree per issue

Each issue gets its own git worktree at `<repo>/.worktrees/<N>-<slug>` on a branch `fix/<N>-<slug>` (issue labelled `bug`) or `feature/<N>-<slug>`, created from freshly fetched origin. Your checkout and branch are never touched. `.worktrees/` is excluded via `.git/info/exclude`. Worktrees are removed after a merge and kept when a run fails, so you can inspect them.

## Docker sandbox and images

The agent runs in a throwaway docker container with the worktree (and the repo's `.git`, mounted at its host path) as the working directory. The container runs as your uid, and holds the Claude token but no GitHub credentials. `--no-sandbox` runs the agent on the host instead.

Images come in two layers:

- **Base** `bunker-claude`: debian trixie-slim with git, bash, ripgrep and the `claude` binary. Built automatically on first use. It has no Python, Node or Bun.
- **Per repo** `.bunker/Dockerfile`: if present, bunker builds it (layer-cached) and runs the agent there. It starts `FROM bunker-claude` and adds whatever the repo needs to run its tests. `--image <name>` uses an image as-is.

## Implement, review, fix

An implementer agent works from the issue (title, body and trusted comments). A reviewer agent then sees the full diff and either approves or lists required changes. Anything the reviewer changes is discarded. On changes requested, the implementer runs again with the feedback. This repeats for up to `--max-rounds` rounds (default 2). Not approved: nothing is pushed. The implementer resumes its own Claude session each round (the feedback is the new prompt) and across `--max-iterations`; reviewers always start fresh, and `--no-resume` turns it off. Session files are kept in `.bunker/sessions/<issue>/` (gitignored; `*.redacted.jsonl` copies for sharing). If a resume fails, bunker falls back to a fresh session.

## Verify in the sandbox

After approval, `.bunker/verify` (or `--verify "<cmd>"`) runs in the worktree inside the sandbox, after `.bunker/setup`. A failure stops the run before anything is pushed. `--verify-on-host` opts out; see [security.md](security.md).

## PR, auto-merge and the landing check

bunker pushes the branch and opens a PR with `Closes #N`. With `--merge` it asks GitHub for auto-merge (squash), so GitHub merges once the required checks pass. bunker never reads CI itself. It polls the PR until it is merged or closed, or `--ci-timeout` minutes pass. After the merge it checks that the files the branch changed are identical on `origin/<default>` and the branch tip (the landing check), then cleans up.

Outcomes: `merged`, `ci-timeout` (PR left open, auto-merge still armed), `merge-failed`, `merge-unverified` (merged, but files differ on the default branch), plus `rejected`, `failed`, `conflict`, `verify-failed` and `pr-opened` (no `--merge`).

## Labels

- `bunker`: queued. `--queue` and `--watch` work these oldest first.
- `discovered`: filed by an agent (or `--audit`) for something out of scope. It waits for a human to triage; relabel it `bunker` to queue it. Agents can't queue work themselves.
- `bunker-failed`: `--watch` swaps `bunker` for this when an issue ends in anything but `merged`, and comments the status and log path. It is never retried automatically; relabel `bunker` to retry.
- `bunker-blocked`: an agent reported a `blocked_by` item (`{"title","body"}`, in its final `<report>` or the reviewer's `<verdict>` JSON; the old `<blocked-by>` tag is a deprecated fallback) because the issue can't be done until something else is. bunker files that blocker as `discovered` (body ends `Blocks #N.`; a human triages it), pushes nothing, removes the worktree and branch, comments `Blocked by #M: <title>` and swaps `bunker` for this label. The result status is `blocked`; it doesn't count toward `--limit` and doesn't stop the queue or `--watch`. The queue also skips any issue whose body or trusted comments say `Blocked by #N` or `Depends on #N` while #N is open (logged as `waiting on #N`). At the start of each queue pass and after each merge, every open `bunker-blocked` issue whose blockers are all closed goes back to `bunker` with the comment `Unblocked: #M is closed`.

## Run logs

Every issue run writes a redacted log to `<repo>/.bunker/runs/<N>-<timestamp>.log` with agent, setup and verify output. The terminal is quiet by default: stage lines, one live progress line on a TTY, and a summary per step. On a failure the last 40 lines and the log path are shown. `--verbose` (or `BUNKER_VERBOSE=1`) streams everything.

## Live view

`bunker ui` serves a page on `127.0.0.1:4321` with one tab per repo: stage, round, time, cost, PR link and feed per issue. Runs publish to it automatically when it is reachable; `--ui` starts one for the run if none is up. See [security.md](security.md).

## Parallel queue

`--queue` is sequential by default: two PRs that are each green against an old main can break main together. `--parallel <n>` (with `--merge`, or under `--watch`) works up to n issues at once, each in its own worktree and container, but keeps merges safe: they happen one at a time in queue order, and before a PR is created bunker merges the latest `origin/<default>` into its branch and re-runs verify in the sandbox. A conflict, or verify failing on the updated branch, gets one fresh attempt of that issue from the new main (a new branch, `-2` suffix); a second failure is handled like any other (`bunker-failed` under `--watch`). `--limit` and the `--watch` spend cap count all concurrent work, though cost is only recorded when an issue finishes, so a cap can be overshot by the issues already in flight. The trade-off is more concurrent spend and rework when issues touch the same files; 2 is recommended. Also consider requiring branches to be up to date in the repo's branch protection as a backstop.
