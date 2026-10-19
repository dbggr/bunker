# bunker

**Label a GitHub issue. Get back a reviewed, tested, merged pull request.**

bunker runs a Claude coding agent on each issue in its own git worktree and Docker sandbox, has a second agent review the change, runs your tests, and lets GitHub's own required checks decide what merges. You choose the work; bunker does it, and stops to ask when it should.

> **Status: beta (v0.9.1).** bunker works its own repository every day (most of its code was written by bunker), but flags, config keys and labels can still change before 1.0. Progress to 1.0: the [v1.0.0 milestone](https://github.com/dbggr/bunker/milestone/1) and [release/v1-readiness.md](release/v1-readiness.md).

## How it works

1. **You label an issue** `bunker:queued`. Only repo admins and maintainers can queue work; bunker checks who added the label.
2. **An agent writes the change** in a sandbox: a fresh git worktree and a Docker container that never sees your GitHub token or SSH keys.
3. **A second agent reviews it** and sends it back with required changes, for up to a few rounds.
4. **Your tests run** in the sandbox with no network and no credentials. If they fail, the agent gets one fix round.
5. **bunker opens a PR and arms GitHub auto-merge.** It merges only when the branch's required status check passes. Changes to CI, bunker's own config or agent instructions always wait for a person; anything it can't finish is labelled `bunker:failed` with the reason.

## Requirements

Linux or macOS with Docker, git and [Bun](https://bun.sh); the [GitHub CLI](https://cli.github.com) logged in; [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) with a Claude subscription or API key; a fine-grained GitHub token (Contents, Pull requests, Issues read/write; Metadata read; *no* Workflows); and a repo with tests and a CI check required by a GitHub **ruleset**. `bunker init` walks you through all of it.

**Cost:** agent runs are billed to your Claude plan or API account. On this repository the average is about $1.29 of agent time per merged issue (Claude Sonnet), and `bunker watch` takes daily and monthly spend caps (`--max-cost-day`, `--max-cost-month`).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/dbggr/bunker/main/install.sh | sh
```

The installer checks prerequisites first and never installs them; for each missing one it links its install page. Then it says what it will do and asks `[y/N]` (`--yes` skips; `--check` only checks; `--skip-runtime-check`, `--ref`, `--uninstall`). It puts a checkout of the latest `vX.Y.Z` release in `~/.local/share/bunker` (`BUNKER_HOME`) and the binary at `~/.local/bin/bunker` (`BUNKER_BIN_DIR`), and doesn't edit your shell rc files. Re-run it to upgrade; `--uninstall` never touches `~/.config/bunker`.

## Quickstart

```sh
cd your-repo
bunker init          # 8 guided steps: tokens, toolchain, a sandbox test run, CI + ruleset, spend cap, labels, a first task
bunker doctor        # every ✓/✗ with the fix for each ✗
bunker issue 12      # one issue, start to finish, and watch it work
bunker watch         # then: work everything labelled bunker:queued, unattended
bunker status        # what it's doing, what merged, and why anything failed
```

## What else it does

Unattended `bunker watch` with `--parallel` runs and spend caps; a PR shepherd that fixes red CI and resolves conflicts; Manual-merge mode; `bunker status` and a live `bunker ui` (runs by state, audit cards, history across restarts); context/spec files and per-role skills; `bunker audit` and `bunker triage` for finding and checking work. See [Concepts](docs/concepts.md).

## Safety

bunker is built to be left running, so the defaults are strict. Only maintainers can queue work, and issues edited after labelling are refused. Comments from non-maintainers never reach the agent. The sandbox gets the repo's git internals read-only. Tests run without network or credentials. Changes to `.bunker/`, `.github/`, `.claude/`, `CLAUDE.md` and `AGENTS.md` always wait for human review. Each of these gates has a test that fails if the gate is removed. The full threat model and its trade-offs are in [docs/security.md](docs/security.md).

## Built with bunker

In its first three days bunker wrote and merged 159 of its own pull requests (29 more were written by hand), with 820 tests and no reverts on `main` (as of 2026-10-19) ([the numbers and failures](release/v1-readiness.md)). It was inspired by Matt Pocock's [sandcastle](https://github.com/mattpocock/sandcastle), a toolkit for building agent loops with many agents and sandbox providers. bunker is one opinionated loop, from issue to merged PR, with the queue, review, merge and unattended safety built in.

## Scope

Before v1.0 bunker won't add other agent providers (Claude only), an interactive mode, cloud or reusable sandboxes, host hooks or plugins (the only host-side code is a `` !`cmd` `` line in `.bunker/prompts/issue.md`, read from the default branch and run without tokens), or npm publishing.

## Docs

[Getting started](docs/getting-started.md) · [Concepts](docs/concepts.md) · [Security](docs/security.md) (the threat model; `--no-sandbox` gives no isolation) · [Troubleshooting](docs/troubleshooting.md) · [CLI reference](docs/cli.md) (generated from `bunker --help`) · [Releasing](docs/release.md)

Contributions welcome: [CONTRIBUTING.md](CONTRIBUTING.md) (develop with `bun test` and `bun run typecheck`). Report security problems privately: [SECURITY.md](SECURITY.md). [MIT License](LICENSE).
