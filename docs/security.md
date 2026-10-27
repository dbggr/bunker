# Security

## What agents can and can't do

An agent runs in a container with the issue worktree and the Claude token. The container joins a dedicated bridge network, `bunker-agent`, created once and reused (it replaced `--network host`, #526), so the host's `127.0.0.1` services are out of reach. **Only the host's loopback is isolated.** The RFC1918 part of #526 is deferred: a plain bridge still reaches the docker gateway, host services bound to `0.0.0.0`, and hosts on your LAN, and bunker does not block them (that needs root-owned firewall rules). `bunker doctor` (optional check "bunker-agent network blocks the LAN and the gateway") reads the host iptables rules and prints the `DOCKER-USER`/`INPUT` rules to install as root (needs root to read them; otherwise add the rule yourself), dropping traffic from the `bunker-agent` subnet (`docker network inspect bunker-agent`) to RFC1918 ranges and the gateway. The agent otherwise keeps full outbound network access.

Manual checks, from a container on the network (`docker run --network bunker-agent alpine wget -T3 -qO- <url>`):

- `http://127.0.0.1:<port>` for a service on the host's localhost: must fail.
- `http://<gateway>:<port>` (gateway from `docker network inspect bunker-agent`) for a host service bound to `0.0.0.0`: reachable unless you added the firewall rule.
- `http://<lan-ip>` for a LAN host: reachable unless you added the firewall rule.

Browser verify: the network is created once and reused, so no veth is added or removed per run, which is what caused `ERR_NETWORK_CHANGED` on the default bridge (#320). This is not covered by an automated test (it needs Chrome in a real container); to check by hand, run a Chrome-based verify on this network and confirm it passes with no `ERR_NETWORK_CHANGED`. Verify and `check` run with no network at all (below). It does not get `BUNKER_GH_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, your SSH keys or your `gh` login: the docker sandbox never passes them, and `--no-sandbox` strips them from the agent's environment and runs it with a temporary empty `HOME` (see below). The agent cannot push or open PRs. bunker does that after review and verify, from the host.

- **Git dir**: bunker runs git on the host in the same repo the agent writes to, so hooks or config planted there would run outside the sandbox. The container gets the git dir read-only, with only `objects/`, `refs/`, `logs/` and its own worktree admin dir writable, and the `.git` pointer file and the admin dir's `commondir`/`gitdir` pointers read-only. Every sandbox step is checked afterwards: if hooks, `config` (apart from `branch.*` entries) or the pointers changed, they are restored and the step fails. Host git always runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false`.
- **Workflow edits**: the token has no Workflows permission, so GitHub refuses a push that changes `.github/workflows/`. bunker has no code that blocks them; the token does. See [troubleshooting.md](troubleshooting.md).
- **Queueing work**: agents can only file issues labelled `discovered`, never `bunker:queued`. A human relabelling is the gate.
- **Verify rules**: `verify` (in `.bunker/config.toml`) is read from origin's default branch, so an agent can't rewrite the check it must pass.
- **Prompt templates**: only `.bunker/prompts/issue.md` is loaded, and it is read from origin's default branch, never a worktree, so the `` !`cmd` `` lines that run on the host always come from merged (human-reviewed, see below) changes.
- **Merging**: nothing merges unless the repo's required CI checks pass on GitHub. bunker refuses (`merge-failed`) to arm auto-merge when the default branch has no required status check, or when it can't read them, because GitHub would merge an already-mergeable PR at once. It reads them from the repository **rulesets** (`rules/branches/<default>`) and from classic branch protection. A fine-grained token can read rulesets (Metadata: read) but classic branch protection needs Administration: read; when that is denied bunker says so rather than reporting no check, so grant it or require the check with a ruleset; see [getting-started.md](getting-started.md#4-set-up-the-repo).

## Token scope

`BUNKER_GH_TOKEN` is a fine-grained token for one repository: Contents RW, Pull requests RW, Issues RW, Actions R, Metadata R.

- Checks and Commit statuses are absent because `--merge` leaves reading CI to GitHub auto-merge. The shepherd reads a PR's CI from the Actions runs and jobs of its head commit plus its legacy commit statuses (see Actions: Read below); the Checks REST endpoints and `statusCheckRollup` would need Checks: read, which fine-grained tokens do not have, so it avoids them.
- Actions: Read is how the shepherd reads CI: workflow runs and jobs of a PR's head commit, and the log of a failed job (`actions/jobs/{id}/logs`) for the fix agent. Fine-grained tokens cannot read check runs, so nothing uses the Checks API. Without it the shepherd cannot see the PR's checks. Never grant Actions: Write.
- Workflows is absent so bunker can't change CI definitions.
- Administration is absent so it can't alter branch protection or repo settings.

Use a short expiry. Even a fully compromised run can then only touch that repo's code, PRs and issues.

## The PR shepherd

The shepherd (`bunker watch`, or `bunker shepherd` once) owns open PRs, so it only touches PRs it can tell are bunker's: a branch of this repo (never a fork) named `feature/<n>-…` or `fix/<n>-…` whose body has `Closes #<n>`. It never merges: it does not call `gh pr merge`; GitHub auto-merge with a required status check stays the only gate. A CI log it hands to the fix agent is untrusted text (anyone who can influence the build output can write into it): it is redacted, fenced and labelled as output, not instructions, and the agent runs in the same sandbox as the implementer without GitHub tokens. A fix is pushed only after verify passes (verify is read from the default branch), and never when it would add changes under `.bunker/`, `.github/` or to agent-steering files that the PR did not already have: those need a human. Review comments are sent to the agent only from the repo owner and users with admin/maintain permission. It keeps no state of its own; its fix attempts are hidden markers in PR comments, bounded to 3 per PR before `bunker:failed`.

## Redaction

Output is passed through a redactor before it reaches the terminal, run logs, the live view or issue comments. It masks the values of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `BUNKER_GH_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, plus token-shaped strings (`github_pat_…`, `ghp_…`, `sk-ant-…`). This is a safety net; keep secrets out of the repo anyway.

Text an agent wrote that bunker posts to GitHub (PR titles, follow-up and audit issues, triage evidence, the "blocked by" and watch comments) is also neutralised: it is redacted, closing keywords (`Fixes #12`, `Closes owner/repo#3`) get a zero-width joiner so they can't close issues, and `@mentions` get one so they can't ping people. Where agent text is quoted inline (finding titles, the reason a run stopped) it is shown as a code span, with the fence longer than any backtick run inside.

## Changes to `.bunker/`, `.github/` and agent instructions need a human

A merged PR controls inputs used on your host: `.bunker/Dockerfile` is built by the host docker daemon, and the `copy` globs in `.bunker/config.toml` decide which untracked host files enter the sandbox. So with `--merge`, a PR that changes anything under `.bunker/` or `.github/` is never auto-merged by bunker. It opens the PR, leaves auto-merge off, labels it `bunker:review` and reports `needs-review`. The issue is not marked failed. Review and merge such a PR yourself.

The same gate covers files CI and verify execute, which are effectively config: `package.json`, `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `composer.json`, `composer.lock` and `Makefile` (at any depth), plus the agent-steering files (`.claude/`, `CLAUDE.md`, `AGENTS.md`). Add your own with `review_paths = ["src/auth/**", "scripts/ci.sh"]` in `.bunker/config.toml` (globs; read from the default branch, and a change to the list is itself gated because `.bunker/` is). `bunker doctor` shows the effective list and where each entry comes from.

`.claude/` (skills, `settings.json`, hooks, commands), `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`, at any depth, are gated the same way: they steer every later agent, so a PR that touches them is labelled `bunker:review` and never auto-merged. The reviewer also never reads the agent's versions: before each review bunker replaces those paths in the worktree with the default branch's (removing any the agent added; gitignored ones such as `.claude/settings.local.json` are moved aside and put back after the review), then discards the checkout, so an agent cannot plant instructions or hooks that steer its own reviewer.

## `--no-sandbox` is not isolation

`--no-sandbox` runs the agent as you, on your filesystem and network. bunker strips the GitHub token variables and gives the agent a temporary empty `HOME` (only claude's login files are copied in), so it can't read `~/.config/bunker/.env`, `~/.config/gh/hosts.yml` or `~/.ssh`. It can still read and write anything else you can, so bunker prints a warning. Use docker or podman for untrusted issues.

## Trusted comments and the label gate

Public repos let anyone write an issue or a comment, and the issue text becomes the agent's prompt.

- The issue body is fenced and flagged as untrusted unless its author is the repo owner, a member or a collaborator. If the author association can't be fetched, bunker treats it as untrusted.
- Only comments from the repo owner or users with admin/maintain permission are included in the prompt (a read/triage collaborator is not enough); others are dropped. `Blocked by #N` in the issue body counts only when its author has admin/maintain permission.
- The `bunker:queued` label is the trust gate; `bunker:in-progress`, `bunker:failed` and `bunker:review` are display only and never queue work. bunker also checks who added it (latest `labeled` event): only repo admins and maintainers count, plus anyone named by `--allow-labeler <login>` or `allow_labelers = ["login"]` in `~/.config/bunker/config.toml`. Otherwise the issue is skipped, the label removed and a comment left; if the permission lookup fails the issue is skipped (fail closed).
- An issue whose title or body was edited after `bunker:queued` was added is refused, unless every later edit was made by an admin, maintainer or allowed labeler. If bunker can't tell who edited it or can't check, it refuses too. Read the new text, then re-add the label (remove `bunker:queued` and add it again) to queue it. Still only apply the label to issues you have read. `discovered` issues are never queued until you relabel them.

## Live view

`bunker ui` binds `127.0.0.1` only, with no option to change that, and rejects foreign `Host` and `Origin` headers (DNS rebinding). The page is read-only: nothing can start, stop or alter a run. Publishing requires the random token in `~/.config/bunker/ui.token` (mode 0600); browsers never see it.

The hub's history files (`$XDG_STATE_HOME/bunker/hub/<owner>_<repo>.jsonl`, default `~/.local/state/bunker/hub/`) hold redacted events only, are written with mode 600 in a directory of mode 700, and stay on the machine. Nothing leaves 127.0.0.1.

## Verify runs in the sandbox

Agent-written code is executed by `verify`, and by the optional `check` command (a typecheck whose output goes to the reviewer), which runs isolated in the same way. By default that happens in the same sandbox as the agent, not on the host with your credentials, but with no network and no Claude credentials (and no GitHub tokens), since it runs code the agent wrote. Setting `verify_network = true` in `.bunker/config.toml` opts back in to the network and Claude credentials, for verify commands that need them. `--verify-on-host` opts out of the sandbox: it runs with no GitHub or Claude tokens in its environment, but otherwise as you; only use it for repos where you'd run the code yourself anyway. The `--step-timeout` limit applies to host verify too: a hung command is killed (with its child processes) and the run fails as `idle-timeout`.
