# Getting started

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

- `.bunker/setup`: runs in each worktree before the agent (worktrees have no `node_modules`), e.g. `bun install`.
- `.bunker/copy` (optional): gitignored files your tests need (e.g. `.env`), one path or glob per line, copied from your checkout into each worktree before setup. They are never committed and `.env*` values are redacted from logs. Paths outside the repo are rejected.
- `.bunker/verify`: the command that must pass before anything is pushed, e.g. `bun test && bun run typecheck`. It is read from origin's default branch, so an agent cannot edit it for its own run, and it runs in the sandbox.
- `.bunker/Dockerfile` (optional): adds the repo's toolchain to the agent image. Start with `FROM bunker-claude`. See [concepts.md](concepts.md).
- On GitHub: enable "Allow auto-merge", and make a CI check required on the default branch. `--merge` hands the merge to GitHub, which merges only when the required checks pass.

Commit these files; the Dockerfile is read from the agent's worktree.

## 5. First run

From the repo's main checkout:

```sh
bunker --issue 12
```

bunker implements issue 12 in a worktree, reviews it, runs `.bunker/verify` and opens a PR. Read the PR before trusting the loop.

## 6. Scale up

Label issues `bunker`, then work the queue:

```sh
bunker --queue --merge
```

Or leave it running unattended:

```sh
bunker --watch --for 5h --max-cost 10
```

`--watch` implies `--queue --merge`, so it needs `.bunker/verify`. Watch the run with `bunker ui`. Every flag is in [cli.md](cli.md); if something goes wrong see [troubleshooting.md](troubleshooting.md).
