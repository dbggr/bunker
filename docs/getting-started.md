# Getting started

## Quick path

After installing (step 1), run `bunker init` in the repo: it checks everything, walks you through the Claude token, the scoped GitHub token, the `.bunker/` files, models and labels, and ends by running `bunker doctor` and printing the first command to use. `bunker init --yes` accepts the proposed defaults non-interactively (it never overwrites existing files and skips the steps that need a secret). `bunker doctor` is read-only and safe to re-run any time; it exits 1 while anything required is missing. `init` never changes repo settings; for auto-merge and the required check it prints what to set. The steps below are the same setup done by hand.

## 1. Install

```sh
bun run build && install -m 755 dist/bunker ~/.local/bin/bunker
bunker --version
```

The base image's Dockerfile is embedded in the binary and built on first use, so Docker (or Podman) must be running.

## 2. Authenticate Claude

```sh
claude setup-token
```

Copy [`.env.example`](../.env.example) to `~/.config/bunker/.env` and set `CLAUDE_CODE_OAUTH_TOKEN` to the token it printed. One file covers every repo. A repo can override it in its own `.bunker/.env` (gitignored). Precedence: exported variables > `<repo>/.bunker/.env` > `~/.config/bunker/.env`.

Models are chosen per role (implementer, reviewer, auditor): `BUNKER_MODEL` sets all of them, `BUNKER_IMPLEMENTER_MODEL` / `BUNKER_REVIEWER_MODEL` / `BUNKER_AUDITOR_MODEL` one role, in the same `.env` files. Flags win: `--implementer-model`, `--reviewer-model`, `--auditor-model`, and `--model` for all. Per role: role flag > `--model` > role env > `BUNKER_MODEL` > Claude Code's default. The model is shown when each role starts, in the run log, in the PR body and in `--ui`.

## 3. Create a scoped GitHub token

Set `BUNKER_GH_TOKEN` in the same `.env`. bunker's own `gh` and `git` calls use it instead of your login. Create a fine-grained token (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens), restricted to the one repository, with a short expiry and exactly these permissions:

- Contents: Read and write
- Pull requests: Read and write
- Issues: Read and write
- Metadata: Read (added automatically)

Nothing else. See [security.md](security.md) for why.

## 4. Set up the repo

In the target repo:

- `.bunker/config.toml`: one file for the repo settings (`bunker init` writes it):

  ```toml
  setup = "bun install"                     # runs in each worktree before the agent (worktrees have no node_modules)
  verify = "bun test && bun run typecheck"  # must pass before anything is pushed
  copy = [".env"]                           # optional: gitignored files your tests need, copied into each worktree
  ```

  `verify` is read from origin's default branch, so an agent cannot edit it for its own run, and it runs in the sandbox. Copied files are never committed and `.env*` values are redacted from logs; paths outside the repo are rejected. Further keys (`[models]`, `[watch]`, `[merge]`, `[queue]`) are listed in [cli.md](cli.md). The older `.bunker/setup`, `.bunker/verify` and `.bunker/copy` files still work but are deprecated. `bunker doctor` shows the effective value and source of every key.
- `.bunker/Dockerfile` (optional): adds the repo's toolchain to the agent image. Start with `FROM bunker-claude`. See [concepts.md](concepts.md).
- On GitHub: enable "Allow auto-merge", and make a CI check required on the default branch. `--merge` hands the merge to GitHub, which merges only when the required checks pass; without auto-merge, or when the repository rulesets (`GET rules/branches/<default>`) show no required status check or cannot be read, bunker refuses (`merge-failed`) rather than merge immediately.

Commit these files; the Dockerfile is read from the agent's worktree.

## 5. First run

From the repo's main checkout:

```sh
bunker --issue 12
```

bunker implements issue 12 in a worktree, reviews it, runs `.bunker/verify` and opens a PR. Read the PR before trusting the loop.

## 6. Scale up

Label issues `bunker:queued`, then work the queue:

```sh
bunker --queue --merge
```

Or leave it running unattended:

```sh
bunker --watch --for 5h --max-cost-day 10
```

`--watch` implies `--queue --merge`, so it needs `.bunker/verify`. Watch the run with `bunker ui`. Every flag is in [cli.md](cli.md); if something goes wrong see [troubleshooting.md](troubleshooting.md).
