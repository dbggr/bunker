# tool-bunker

Bun spike of sandboxed coding-agent orchestration, after [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle).

```
run(prompt) → git worktree on bunker/<id> → agent runs in sandbox → collect base..branch commits → merge back → clean up
```

## Use

```bash
bun install
docker build -t bunker-claude .           # agent image (git + claude)
claude setup-token                        # then export CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)

cd /some/repo
bun ~/Projects/Management/tool-bunker/src/cli.ts "add a greet() helper" [--model <id>] [--no-sandbox]
```

Or as a library:

```ts
import { run, claudeCode, docker } from "./src/index.ts";
const { commits } = await run({ prompt: "...", agent: claudeCode(), sandbox: docker() });
```

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
