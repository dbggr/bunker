# Security

## What agents can and can't do

An agent runs in a container with the issue worktree and the Claude token. It does not get `BUNKER_GH_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, your SSH keys or your `gh` login: the docker sandbox never passes them, and `--no-sandbox` strips them from the agent's environment and runs it with a temporary empty `HOME` (see below). The agent cannot push or open PRs. bunker does that after review and verify, from the host.

- **Workflow edits**: the token has no Workflows permission, so GitHub refuses a push that changes `.github/workflows/`. bunker has no code that blocks them; the token does. See [troubleshooting.md](troubleshooting.md).
- **Queueing work**: agents can only file issues labelled `discovered`, never `bunker`. A human relabelling is the gate.
- **Verify rules**: `.bunker/verify` is read from origin's default branch, so an agent can't rewrite the check it must pass.
- **Prompt templates**: `.bunker/prompts/*.md` are read from origin's default branch, never a worktree, so the `` !`cmd` `` lines that run on the host always come from merged (human-reviewed, see below) changes.
- **Merging**: nothing merges unless the repo's required CI checks pass on GitHub.

## Token scope

`BUNKER_GH_TOKEN` is a fine-grained token for one repository: Contents RW, Pull requests RW, Issues RW, Metadata R.

- Checks, Actions and Commit statuses are absent because `--merge` leaves reading CI to GitHub auto-merge.
- Workflows is absent so bunker can't change CI definitions.
- Administration is absent so it can't alter branch protection or repo settings.

Use a short expiry. Even a fully compromised run can then only touch that repo's code, PRs and issues.

## Redaction

Output is passed through a redactor before it reaches the terminal, run logs, the live view or issue comments. It masks the values of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `BUNKER_GH_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, plus token-shaped strings (`github_pat_…`, `ghp_…`, `sk-ant-…`). This is a safety net; keep secrets out of the repo anyway.

## Changes to `.bunker/`, `.github/` and agent instructions need a human

A merged PR controls inputs used on your host: `.bunker/Dockerfile` is built by the host docker daemon, and the `copy` globs in `.bunker/config.toml` decide which untracked host files enter the sandbox. So with `--merge`, a PR that changes anything under `.bunker/` or `.github/` is never auto-merged by bunker. It opens the PR, leaves auto-merge off, labels it `needs-human-review` and reports `needs-review`. The issue is not marked failed. Review and merge such a PR yourself.

`.claude/` (skills, `settings.json`, hooks, commands), `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`, at any depth, are gated the same way: they steer every later agent, so a PR that touches them is labelled `needs-human-review` and never auto-merged. The reviewer also never reads the agent's versions: before each review bunker replaces those paths in the worktree with the default branch's (removing any the agent added; gitignored ones such as `.claude/settings.local.json` are moved aside and put back after the review), then discards the checkout, so an agent cannot plant instructions or hooks that steer its own reviewer.

## `--no-sandbox` is not isolation

`--no-sandbox` runs the agent as you, on your filesystem and network. bunker strips the GitHub token variables and gives the agent a temporary empty `HOME` (only claude's login files are copied in), so it can't read `~/.config/bunker/.env`, `~/.config/gh/hosts.yml` or `~/.ssh`. It can still read and write anything else you can, so bunker prints a warning. Use docker or podman for untrusted issues.

## Trusted comments and the label gate

Public repos let anyone write an issue or a comment, and the issue text becomes the agent's prompt.

- The issue body is fenced and flagged as untrusted unless its author is the repo owner, a member or a collaborator. If the author association can't be fetched, bunker treats it as untrusted.
- Only comments from the repo owner or users with admin/maintain permission are included in the prompt (a read/triage collaborator is not enough); others are dropped. `Blocked by #N` in the issue body counts only when its author has admin/maintain permission.
- The `bunker` label is the trust gate. bunker also checks who added it (latest `labeled` event): only repo admins and maintainers count, plus anyone named by `--allow-labeler <login>` or `allow-labelers = ["login"]` in `~/.config/bunker/config.toml`. Otherwise the issue is skipped, the label removed and a comment left; if the permission lookup fails the issue is skipped (fail closed). Still only apply the label to issues you have read. `discovered` issues are never queued until you relabel them.

## Live view

`bunker ui` binds `127.0.0.1` only, with no option to change that, and rejects foreign `Host` and `Origin` headers (DNS rebinding). The page is read-only: nothing can start, stop or alter a run. Publishing requires the random token in `~/.config/bunker/ui.token` (mode 0600); browsers never see it.

## Verify runs in the sandbox

Agent-written code is executed by `.bunker/verify`. By default that happens inside the same container as the agent, not on the host with your credentials. `--verify-on-host` opts out; only use it for repos where you'd run the code yourself anyway. The `--step-timeout` limit applies to host verify too: a hung command is killed (with its child processes) and the run fails as `idle-timeout`.
