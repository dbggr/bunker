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

## Parallel runs

```ts
import { runAll, claudeCode, docker } from "./src/index.ts";
const results = await runAll({
  tasks: [{ prompt: "add a greet() helper" }, { prompt: "add a farewell() helper" }],
  agent: claudeCode(),
  sandbox: docker(),
});
```

`runAll()` gives each task its own worktree, all from the same base commit. Worktrees are created one at a time (git locks the shared `.git`), agents run concurrently, and merges land one at a time in task order.

Each task gets a status in its result: `merged`, `conflict` or `failed`. Nothing is thrown for a single task; failed and conflicting branches are kept (`bunker/<id>`) for inspection.

CLI form:

```bash
bun ~/Projects/Management/tool-bunker/src/cli.ts --task "add a greet() helper" --task "add a farewell() helper"
```

It prints one line per task and exits 1 if any task isn't `merged`.

## Iterations

```ts
const result = await run({
  prompt: "Work through the TODO list. When every item is done, print <promise>COMPLETE</promise>.",
  agent: claudeCode(),
  sandbox: docker(),
  maxIterations: 10,
  // completionSignal: "ALL DONE",             // or ["ALL DONE", "GIVING UP"]
});
result.iterations; // [{ exitCode, commits }, ...] one per iteration
result.completionSignal; // the signal that stopped the loop, if any
```

With `maxIterations` above 1 the agent is re-run with the *same prompt* in the *same worktree*, one iteration after another, so each pass sees the previous passes' commits. The loop stops after an iteration whose stdout contains a completion signal (default `<promise>COMPLETE</promise>`), or at `maxIterations` (default 1, i.e. a single run).

The engine never adds the signal to your prompt, so tell the agent about it yourself. A non-zero exit in any iteration fails the run and keeps the branch, as for a single run. `commits` is the total across iterations; each entry of `iterations` has the commits that pass added. `runAll()` takes the same options and applies them per task.

Agent stdout is still streamed live; `Sandbox.exec` also returns it as `{ code, stdout }` so the signal can be detected.

CLI: `--max-iterations <n>` applies to a single prompt and to every `--task`.

## Review pipeline

```ts
import { review, claudeCode, docker } from "./src/index.ts";
const result = await review({
  prompt: "add a greet() helper",
  agent: claudeCode(),
  // reviewer: claudeCode({ model: "..." }),   // defaults to agent
  sandbox: docker(),
  maxRounds: 2,
  // approveSignal: "<review>APPROVE</review>",
});
result.status; // "approved" | "rejected" | "failed" | "conflict"
result.rounds; // [{ commits, approved, feedback }, ...]
```

`review()` runs implement → review → fix rounds in one worktree and branch:

1. The implementer runs. Round 1 gets the prompt; later rounds get the prompt plus `A reviewer requested changes:\n<feedback>`.
2. The reviewer runs in the same worktree with a prompt bunker builds: the task, the full `git diff <base>..HEAD`, and instructions not to modify files or commit and to print the approve signal if the change is acceptable, otherwise list the required changes.
3. Anything the reviewer changed or committed is discarded (worktree reset to the pre-review HEAD, untracked files cleaned), so only the implementer's commits survive.
4. If the reviewer's stdout contains the approve signal the branch is merged back as in `run()`. Otherwise after `maxRounds` it is not merged and the branch is kept.

Agents get a mode: `Agent.command(prompt, "write" | "review")`. `claudeCode()` only appends its commit instruction in write mode (the default).

Nothing is thrown for the four statuses. A non-zero exit from either agent is `failed`. The branch is kept for `rejected`, `failed` and `conflict` and deleted after a clean merge; the worktree is always removed. `feedback` is the reviewer's stdout.

CLI: `--review "<prompt>" [--max-rounds <n>] [--reviewer-model <id>]` (single prompt only) prints one line per round and the final status, and exits 1 unless approved.

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
