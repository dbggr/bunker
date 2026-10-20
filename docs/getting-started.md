# Getting started

## Quick path

After installing (step 1), run `bunker init` in the repo. It is the whole first run in one guided pass, eight steps with a progress line, a one-line "why this matters" for each, and a default on every question:

```text
[1/8] Welcome            what bunker does, needs and writes; a rough cost note
[2/8] Claude token       `claude setup-token`, validated
[3/8] GitHub identity    the exact token checklist + a pre-filled link, validated live
[4/8] Toolchain          detects npm/pnpm/yarn/bun, composer, python, cargo, go, monorepos; you can edit setup and verify
[5/8] Sandbox image      builds the image, runs setup and verify once as an unattended run will, shows the tail
[6/8] Merge safety       a CI workflow (as a PR) and a ruleset requiring it, or the exact clicks
[7/8] Spend and models   a daily cap (default $20), optional monthly cap, models
[8/8] Labels             then a guided first task: a tiny issue, run attended, no auto-merge
```

Nothing is written or created before a confirm that names the file or setting. Re-running `bunker init` skips what is already ✓ and says so, and Ctrl-C leaves no half-written files. `bunker init --yes` takes every default and never reads input; it does not open PRs or change repo settings, and lists at the end the steps that need you. `bunker init --explain <step>` re-reads a step (for example `--explain github`). `NO_COLOR=1` turns off colour and glyphs. `bunker doctor` is read-only and safe to re-run any time; it exits 1 while anything required is missing. The steps below are the same setup done by hand.

## 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/dbggr/bunker/main/install.sh | sh
bunker --version
```

`install.sh` checks the prerequisites (git, bun, docker, gh, claude), builds the latest release tag into `~/.local/share/bunker` and links `~/.local/bin/bunker`; see the [README](../README.md#install). The base image's Dockerfile is embedded in the binary and built on first use, so Docker (or Podman) must be running.

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
- Actions: Read: the PR shepherd reads CI from the workflow runs and jobs of the PR's head commit (plus its commit statuses), because a fine-grained token has no Checks permission and `gh pr checks` / `check-runs` answer 403. It also reads the log of a failed job for the fix agent. Without it the shepherd cannot see the checks at all (`bunker doctor` reports `Actions` as missing)

Nothing else. See [security.md](security.md) for why.

## 4. Set up the repo

In the target repo:

- `.bunker/config.toml`: one file for the repo settings (`bunker init` writes it):

  ```toml
  setup = "bun install"                     # runs in each worktree before the agent (worktrees have no node_modules)
  verify = "bun test && bun run typecheck"  # must pass before anything is pushed (or pass --verify)
  copy = [".env"]                           # optional: gitignored files your tests need, copied into each worktree
  ```

  `verify` is read from origin's default branch, so an agent cannot edit it for its own run, and it runs in the sandbox. Copied files are never committed and `.env*` values are redacted from logs; paths outside the repo are rejected. Other top-level keys: `verify_network` (give sandboxed verify the network), `verify_retries` (fix rounds when verify fails, default 1), `check` (a command such as a typecheck, run isolated before each review, its output goes to the reviewer) and `context` (repo files inlined into the prompts), `prepare` and `[services.<name>]` (databases for verify; see [concepts.md](concepts.md#services-for-verify-databases)). Tables: `[models]`, `[skills]`, `[watch]` (including `triage_every`), `[merge]` (`merge.mode = "manual"` leaves PRs for you to merge), `[clean]` (`logs_days`) and `[notify]`; all are listed in [cli.md](cli.md). Spend caps for every repo, `max_cost_day` and `max_cost_month`, go in `~/.config/bunker/config.toml`; a repo's own `[watch]` `max_cost_day` / `max_cost_month` override them for that repo, and `--max-cost-day` / `--max-cost-month` override both. A leftover `.bunker/setup` or `.bunker/verify` file is an error (move it into `config.toml`); the older `.bunker/copy` file still works. `bunker doctor` shows the effective value and source of every key.
- `.bunker/Dockerfile` (optional): adds the repo's toolchain to the agent image. Start with `FROM bunker-claude`. See [concepts.md](concepts.md).
- On GitHub: enable "Allow auto-merge", and make a CI check required on the default branch. `--merge` hands the merge to GitHub, which merges only when the required checks pass; without auto-merge, or when the repository rulesets (`GET rules/branches/<default>`) show no required status check or cannot be read, bunker refuses (`merge-failed`) rather than merge immediately. A repository **ruleset** (Settings → Rules → Rulesets) or classic branch protection both count; the fine-grained token reads rulesets as is, but classic branch protection needs Administration: read (see [security.md](security.md)).

Commit these files; the Dockerfile is read from the agent's worktree.

## 5. First run

From the repo's main checkout:

```sh
bunker issue 12
```

bunker implements issue 12 in a worktree, reviews it, runs `verify` and opens a PR. Read the PR before trusting the loop.

## 6. Scale up

Label issues `bunker:queued`, then work the queue:

```sh
bunker queue --merge
```

Or leave it running unattended:

```sh
bunker watch --for 5h --max-cost-day 10
```

`bunker watch` implies `bunker queue --merge`, so it needs `verify` in `config.toml`. Watch the run with `bunker ui`. Every flag is in [cli.md](cli.md); if something goes wrong see [troubleshooting.md](troubleshooting.md).

## Optional: run watches through the MCP

Instead of starting `bunker watch` by hand, let Claude run it as a `bunker-watch@` systemd user unit through `bunker mcp`. Add the server once, at user scope, so it works from any repo:

```sh
claude mcp add -s user bunker -- bunker mcp
```

Then ask Claude to start, stop or restart the watch, read its logs, check spend or queue an issue. The unit template is installed on the first `start_watch`. Only watches started this way are managed: a `bunker watch` you started by hand in a terminal is invisible to `list_watches`, and the MCP can't stop it. The tools are listed under `bunker mcp` in [cli.md](cli.md).

## Optional: a separate GitHub identity

Everything above uses your own PAT, so every PR is authored by you and GitHub won't let you approve it. If you want separate attribution, or "auto-merge, but only after I approve", give bunker its own identity. This is opt-in; with only `BUNKER_GH_TOKEN` set nothing changes, and `bunker init` asks (default no).

> Not yet tested end to end against a real repository; tracked in [#372](https://github.com/dbggr/bunker/issues/372).

**A GitHub App** (preferred). Create a private App with no webhook and the permissions Contents, Pull requests and Issues: Read and write; Metadata, Actions, Checks and Statuses: Read. Don't grant Workflows. Install it on the repo, generate a private key, and set in `~/.config/bunker/.env`:

```sh
BUNKER_APP_ID=<app id>
BUNKER_APP_PRIVATE_KEY_PATH=~/.config/bunker/bunker-app.pem   # chmod 600
```

At run start bunker signs a JWT with the key, finds the repo's installation (`GET /repos/{owner}/{repo}/installation`), mints an installation token (`POST /app/installations/{id}/access_tokens`) and uses it for push, PR, issue, comment and label calls. Tokens last an hour; bunker renews them before they expire. The key and the tokens are never passed into a sandbox, and output is redacted.

**A bot account.** Create a GitHub user for bunker, add it as a collaborator, and set `BUNKER_BOT_GH_TOKEN` to its fine-grained PAT (same permissions as above). It takes the place of `BUNKER_GH_TOKEN`.

If both are configured the App wins. If the App can't mint a token bunker stops; it does not fall back to your PAT. Commits still carry your configured git author. The maintainer gate and trusted-comment rules still key on the human maintainer: comments by the bot never count as trusted. `bunker doctor` shows which identity is in use and whether it can read the repo, issues and PRs.

**Recipe: require your approval before merge.** Because the PR author is now the bot, you can approve it:

1. Settings → Rules → Rulesets (or branch protection) for the default branch: require a pull request with 1 approving review, plus your CI check.
2. Allow auto-merge in Settings → General.
3. bunker opens the PR and enables auto-merge; it waits for CI and your approval.
4. Approve the PR; auto-merge lands it.
