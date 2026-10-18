# bunker

bunker turns GitHub issues into reviewed, verified, merged PRs. Each issue is worked by a coding agent in its own git worktree and docker sandbox, then reviewed by a second agent. bunker pushes and merges only after your checks pass.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/dbggr/tool-bunker/main/install.sh | sh
# while the repo is private:
gh api repos/dbggr/tool-bunker/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
```

It checks prerequisites first (git and bun to build; docker, gh logged in, and claude to run) and never installs them; it links to each missing one's install page. Then it says what it will do and asks `[y/N]` (`--yes` skips; `--check` only checks; `--skip-runtime-check`, `--ref`, `--uninstall`). It puts a checkout at the latest `vX.Y.Z` tag in `~/.local/share/bunker` (`BUNKER_HOME`) and the binary at `~/.local/bin/bunker` (`BUNKER_BIN_DIR`), and does not edit shell rc files. Re-run it to upgrade; `--uninstall` never touches `~/.config/bunker`.

## Quickstart

```sh
bun run build && install -m 755 dist/bunker ~/.local/bin/bunker
claude setup-token                  # put the token in ~/.config/bunker/.env
cd your-repo                        # add .bunker/config.toml (setup, verify)
bunker issue 12                   # one issue to a PR
bunker queue --merge              # everything labelled `bunker:queued`
```

## Features

- Worktree and docker sandbox per issue; your checkout is never touched
- Implement, review, fix rounds, then verify in the sandbox
- PR with GitHub auto-merge and a landing check
- Work queue by label, and unattended `bunker watch` with optional daily and monthly spend caps
- Opt-in `--parallel <n>` for `bunker queue --merge` and `bunker watch`: n issues at once, merges still serial and each branch updated to the latest main and re-verified first. The trade-off is more concurrent spend and rework when issues touch the same files; 2 is a good choice
- Agents file out-of-scope findings as `discovered` issues for human triage
- Scoped GitHub token and output redaction; agents never see GitHub credentials
- Live multi-repo view with `bunker ui`
- Read-only `bunker audit` that files improvement ideas
- `bunker triage`: a read-only agent verifies `discovered` issues (fixed, as designed, duplicate, valid); queueing stays with you
- Starts each run with a safe `git pull --ff-only` of your checkout (clean, default branch only; `--no-pull` disables it), and `bunker self-update` rebuilds the binary from its own checkout

## Scope

Before v1.0 bunker will not build:

- other agent providers (Claude only)
- an interactive mode
- cloud or reusable sandboxes
- prompt templating
- host hooks
- npm publishing (the package stays `@dbggr/bunker` and private)

## Docs

- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md)
- [Security](docs/security.md): token handling, `.bunker/` changes need human review, `--no-sandbox` gives no isolation
- [Troubleshooting](docs/troubleshooting.md)
- [CLI reference](docs/cli.md) (generated from `bunker --help`)
- [Releasing](docs/release.md)

Develop with `bun test` and `bun run typecheck`.

Licensed under the [MIT License](LICENSE).
