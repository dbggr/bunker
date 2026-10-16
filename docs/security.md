# Security

## What agents can and can't do

An agent runs in a container with the issue worktree and the Claude token. It does not get `BUNKER_GH_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, your SSH keys or your `gh` login: the docker sandbox never passes them, and `--no-sandbox` strips them from the agent's environment. The agent cannot push or open PRs. bunker does that after review and verify, from the host.

- **Workflow edits**: the token has no Workflows permission, so GitHub refuses a push that changes `.github/workflows/`. bunker has no code that blocks them; the token does. See [troubleshooting.md](troubleshooting.md).
- **Queueing work**: agents can only file issues labelled `discovered`, never `bunker`. A human relabelling is the gate.
- **Verify rules**: `.bunker/verify` is read from origin's default branch, so an agent can't rewrite the check it must pass.
- **Merging**: nothing merges unless the repo's required CI checks pass on GitHub.

## Token scope

`BUNKER_GH_TOKEN` is a fine-grained token for one repository: Contents RW, Pull requests RW, Issues RW, Metadata R.

- Checks, Actions and Commit statuses are absent because `--merge` leaves reading CI to GitHub auto-merge.
- Workflows is absent so bunker can't change CI definitions.
- Administration is absent so it can't alter branch protection or repo settings.

Use a short expiry. Even a fully compromised run can then only touch that repo's code, PRs and issues.

## Redaction

Output is passed through a redactor before it reaches the terminal, run logs, the live view or issue comments. It masks the values of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `BUNKER_GH_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, plus token-shaped strings (`github_pat_…`, `ghp_…`, `sk-ant-…`). This is a safety net; keep secrets out of the repo anyway.

## Trusted comments and the label gate

Public repos let anyone write an issue or a comment, and the issue text becomes the agent's prompt.

- The issue body is fenced and flagged as untrusted unless its author is the repo owner, a member or a collaborator. If the author association can't be fetched, bunker treats it as untrusted.
- Only comments from owners, members and collaborators are included in the prompt. Others are dropped.
- The `bunker` label is the trust gate. Only people with triage rights can add it, so only apply it to issues you've read. `discovered` issues are never queued until you relabel them.

## Live view

`bunker ui` binds `127.0.0.1` only, with no option to change that, and rejects foreign `Host` and `Origin` headers (DNS rebinding). The page is read-only: nothing can start, stop or alter a run. Publishing requires the random token in `~/.config/bunker/ui.token` (mode 0600); browsers never see it.

## Verify runs in the sandbox

Agent-written code is executed by `.bunker/verify`. By default that happens inside the same container as the agent, not on the host with your credentials. `--verify-on-host` opts out; only use it for repos where you'd run the code yourself anyway.
