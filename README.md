# tool-bunker

Bun spike of sandboxed coding-agent orchestration, after [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle).

```
run(prompt) → git worktree on bunker/<id> → agent runs in sandbox → collect base..branch commits → merge back → clean up
```

## Use

```bash
bun install
claude setup-token                        # then export CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)

cd /some/repo
bun ~/Projects/Management/tool-bunker/src/cli.ts "add a greet() helper" [--model <id>] [--no-sandbox]
```

Or as a library:

```ts
import { run, claudeCode, docker } from "./src/index.ts";
const { commits } = await run({ prompt: "...", agent: claudeCode(), sandbox: docker() });
```

## Agent images: base + per-repo

The container only runs the agent, so it needs no Bun or Node of its own, just git and claude. Anything else the agent needs to *verify* its work (run tests, lint) is the target repo's toolchain, so each repo adds that itself.

- **Base** `bunker-claude` ([`images/base/Dockerfile`](images/base/Dockerfile)): debian trixie-slim + git, ca-certificates, bash, ripgrep + the native `claude` binary (pinned via `CLAUDE_VERSION`). Built automatically on first use.
- **Per repo** `.bunker/Dockerfile`: if the target repo has one, `docker()` builds it (tag `bunker-repo-<name>-<hash>`, layer-cached) and runs the agent there. Build context is `.bunker/`. Example, this repo's own:

  ```dockerfile
  FROM bunker-claude
  COPY --from=oven/bun:1.4.2-slim /usr/local/bin/bun /usr/local/bin/bun
  RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
  ```

  A PHP repo would `RUN apt-get install -y php-cli composer`, a Vite site would copy in node, and so on.
- **Override**: `docker({ image })` uses that image as-is; `docker({ baseImage })` changes what the base is assumed to be.

The `.bunker/Dockerfile` is read from the agent's worktree, so it must be committed to take effect.

## How it works (`src/index.ts`)

- **Agent**: `prompt → argv`. `claudeCode()` is `claude -p <prompt> --dangerously-skip-permissions`.
- **Sandbox**: runs that argv with the worktree as cwd. `noSandbox()` = host; `docker()` = throwaway container.
- **Why two mounts**: a worktree's `.git` is a file pointing at `<repo>/.git/worktrees/<id>` by absolute path, so `docker()` mounts the worktree *and* the repo's `.git` at their host paths.
- **Why `--user`**: the container runs as your uid so files and git objects it writes aren't root-owned (and claude refuses `--dangerously-skip-permissions` as root).
- **Secrets**: auth env vars are passed as `-e NAME` (name only), so values never appear in argv.
- **Failure**: worktree is always removed; on agent failure or merge conflict the `bunker/<id>` branch is kept for inspection.

## Test

```bash
bun test        # docker tests skip when docker isn't running
```

## Auth

The container has no access to your host login, so `docker()` needs a token passed in:

1. `claude setup-token` on the host (uses your Claude subscription).
2. Copy [`.env.example`](.env.example) to `~/.config/bunker/.env` (or `$XDG_CONFIG_HOME/bunker/.env`) and set `CLAUDE_CODE_OAUTH_TOKEN`. One file covers every repo.
   `ANTHROPIC_API_KEY` is there commented out if you'd rather bill an API key.

To use a different token for one repo, put it in that repo's `.bunker/.env` (gitignored). Precedence: exported variables > `<repo>/.bunker/.env` > `~/.config/bunker/.env`. The CLI exits with a `claude setup-token` hint if neither variable is set. `--no-sandbox` skips the check, since claude on the host uses your normal login.
