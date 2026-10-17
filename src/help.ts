import { CONFIG_HELP } from "./config.ts";

export const HELP = `bunker - run coding agents in sandboxed git worktrees

Usage:
  bunker init [--yes]                         set up this repo: tokens, .bunker/ files, models, labels (--yes: accept defaults)
  bunker doctor                               read-only setup check: ✓/✗ with a fix for each; exit 1 if anything required is missing
  bunker "<prompt>" [options]                 single prompt: one agent run, merged back
  bunker --task "<p>" --task "<p>" ...        parallel: one worktree per task
  bunker --review "<prompt>"                  implement -> review -> fix rounds
  bunker --issue <n>                          GitHub issue -> reviewed PR
  bunker --queue                              work the \`bunker\` label queue
  bunker --watch                              keep working the queue unattended (implies --queue --merge)
  bunker ui [--port <n>]                      shared live view: one tab per repo (default port 4321)
  bunker --audit                              file improvement ideas as \`discovered\` issues
  bunker clean [--yes] [--logs <days>] [--images] [--force]   remove leftover worktrees and branches (dry run unless --yes)
  bunker self-update [--channel main]         build and install the latest v* release tag (--channel main: pull main instead)

Common options (all modes):
  --model <id>               model for every role (implementer, reviewer, auditor)
  --implementer-model <id>   model for the implementer
  --auditor-model <id>       model for the --audit agent
  --image <name>             use this docker image as-is
  --no-sandbox               run the agent on the host instead of in docker
  -h, --help                 show this help (wins over every other flag)
  --verbose                  stream all agent, setup and verify output (also BUNKER_VERBOSE=1)
  --version                  print the version and the tag (or main@<sha>) it was built from
  --no-pull                  (--issue, --queue, --watch, --audit) skip the \`git pull --ff-only\` of your checkout that
                             otherwise runs first, only when it has no tracked changes and is on the default branch

Single prompt and --task:
  --max-iterations <n>       re-run the agent up to n times in one worktree (default 1)
  --task "<prompt>"          repeatable; each task gets its own worktree

--review, --issue, --queue:
  --review                   implement -> review -> fix a single prompt
  --max-rounds <n>           review rounds before giving up (default 2)
  --reviewer-model <id>      model for the reviewer
  --no-resume                start every implementer round (and --max-iterations pass) in a fresh agent session instead of
                             resuming the previous one with the reviewer feedback

--issue and --queue:
  --issue <n>                implement GitHub issue n and open a PR
  --queue                    run open issues labelled \`bunker\`, in order: \`priority:high\`, \`priority:medium\`, no priority,
                             \`priority:low\`; within a priority \`bug\` issues first; then oldest first (--watch re-orders between
                             issues). Prints the order with the reason per issue. Skips any with an open
                             \`Blocked by #N\` / \`Depends on #N\`. An agent that reports a blocked_by item in its <report>/<verdict> JSON
                             gets its blocker filed as \`discovered\` and the issue relabelled \`bunker-blocked\`
                             (no PR, doesn't count toward --limit); it returns to \`bunker\` once the blockers close
  --allow-labeler <login>    (--issue, --queue, --watch; repeatable) also accept the \`bunker\` label from this GitHub user. By
                             default only repo admins and maintainers may queue work: otherwise the issue is skipped, the label
                             removed and a comment left. Also: allow-labelers = ["login"] in ~/.config/bunker/config.toml.
                             If the permission lookup fails the issue is skipped (fail closed)
  --limit <n>                (--queue) max issues per run (default 5; blocked issues don't count)
  --parallel <n>             (--queue --merge, --watch) work up to n issues at once, one worktree + container each (default 1).
                             Merges stay serial, in queue order: each PR's branch is first updated to the latest default
                             branch and re-verified; a conflict or failure then gets one fresh attempt from the new main.
                             Trade-off: more concurrent spend, and rework when issues touch the same files; 2 is a good choice
  --setup "<cmd>"            run in the worktree before the agent (default: setup in config.toml, else .bunker/setup)
  --verify "<cmd>"           run after approval; a failure stops before pushing (default: verify in config.toml, else .bunker/verify)
  --verify-on-host           run --verify on the host instead of in the sandbox
  --merge                    auto-merge the PR once checks pass (requires --verify or verify in config.toml)
  --ci-timeout <min>         (--merge) minutes to wait for the merge (default 30)
  --idle-timeout <min>       kill an agent or reviewer that prints nothing for this long; the step fails as
                             idle-timeout, worktree and branch kept (default 10)
  --completion-timeout <s>   seconds an agent may linger after its final result event before it is
                             killed and the step counts as done, with a warning (default 60)
  --step-timeout <min>       overall limit for setup and verify, which can be quiet for long (default 30)

--issue, --queue, --watch, --audit, live view:
  Every run publishes to a bunker hub (bunker ui) if one is reachable on 127.0.0.1:4321,
  tagged with the repo (owner/repo from origin); with no hub it just carries on.
  --ui                       make sure a hub is up (start one for this run if not), publish, print the URL
  --port <n>                 (--ui) hub port to use (default 4321)
  --ui-keep                  (--ui) keep the hub this run started alive after it ends (Ctrl-C to quit)

--watch:
  --watch                    loop: work the queue, sleep, repeat until Ctrl-C; needs --verify or verify in config.toml
  --interval <min>           minutes to sleep when no work is waiting (default 10)
  --for <duration>           stop starting new issues after this long, e.g. 5h, 90m, 2h30m (default: until Ctrl-C)
  --max-cost-day <usd>       stop starting issues once this much (notional USD, as \`claude -p\` reports it) was spent in a rolling 24 h,
                             then sleep until the window frees up; kept in .bunker/watch-spend.json (default: no cap).
                             Also max-cost-day in ~/.config/bunker/config.toml. \`--max-cost\` is an alias
  --max-cost-month <usd>     same for a rolling 30 days (default: no cap; config.toml: max-cost-month)
  --audit-every <days>       also run --audit at most once per this many days, kept in .bunker/watch-state.json (default off; 30 is a good value)
  Failed issues get \`bunker-failed\` instead of \`bunker\` and are never retried automatically.

--audit:
  --audit                    read-only agent run that files issues
  --max-issues <n>           max issues to file (default 5); only high/medium severity are filed, as \`discovered\` + \`severity:*\`
  --focus "<text>"           steer the audit toward a topic
  --setup "<cmd>"            run in the worktree before the agent

init and doctor:
  bunker doctor              read-only, safe to re-run: checks tools (docker, git, gh, claude), auth (Claude token, scoped
                             BUNKER_GH_TOKEN and the permissions it lacks), repo files, GitHub labels / auto-merge / CI /
                             required check, the model per role, and the effective value and source of every .bunker/config.toml
                             key (config.toml is validated). Prints ✓/✗ with a one-line fix; exit 1 if anything
                             required is missing
  bunker init                interactive, per repo: runs doctor, then walks each ✗: Claude token (via \`claude setup-token\`)
                             and the scoped GitHub token (hidden input, validated, stored 0600 in ~/.config/bunker/.env),
                             .bunker/config.toml (setup, verify) and Dockerfile for the detected toolchain (asks before each write, never
                             overwrites), models, and the four labels. It never changes repo settings (auto-merge, branch
                             protection, required checks): it prints what to set. Ends with doctor and the first command to run
  A one-word prompt "init" or "doctor" is read as the subcommand; to use it as a prompt put -- first: bunker -- init
                             (or make it longer than one word).
  --yes                      (init) accept every proposed default without asking; still never overwrites a file and skips the
                             steps that need a secret from you

clean:
  bunker clean               run from the repo's main checkout. Dry run by default: prints what it would remove and why.
                             Worktrees: .worktrees/<n>-* whose issue is closed or whose PR is merged/closed; /tmp/bunker-*
                             worktrees of this repo that no running process uses. Branches: bunker/<id> without a worktree;
                             {feature|fix}/<n>-<slug> whose PR is merged/closed or that have no commits beyond origin/<default>.
                             Anything with commits not on origin/<default>, or uncommitted changes, is first kept as the tag
                             bunker/stale/<name>-<timestamp> (printed). Only bunker's own names are touched. Ends with git worktree prune
  --yes                      (clean) really remove
  --logs <days>              (clean) also remove .bunker/runs/*.log older than this (default: keep all)
  --images                   (clean) also remove bunker-repo-* docker images no running container uses (bunker-claude is kept)
  --force                    (clean) go ahead although a --watch lock for this repo is held by a live process (otherwise exit 2)
  --issue, --queue and --watch run the same worktree and branch cleanup at start-up, and Ctrl-C/SIGTERM removes the
  current run's /tmp/bunker-* worktree and bunker/<id> branch if it has no commits.

Repo config (.bunker/config.toml, parsed as TOML; .bunker/Dockerfile stays a separate file):
  Precedence: CLI flag > env var > config.toml > legacy files (.bunker/setup, verify, copy) > built-in default.
  Legacy files keep working but are deprecated (a note is printed when both exist). Unknown keys warn; a key of
  the wrong type exits 2.
  Keys (tables: [models], [watch], [merge]):
${CONFIG_HELP}

Legacy .bunker/copy (same as copy in config.toml):
  .bunker/copy               gitignored files to copy from your checkout into each worktree before setup (e.g. .env):
                             one path or glob per line, \`#\` comments; directories are copied recursively, missing
                             paths warn. Paths outside the repo (\`..\`, absolute) are rejected. Copied files are never
                             committed (a commit that includes one fails the run) and the values of copied .env* files
                             are redacted from output. Library option: copyToWorktree: string[] overrides the file

Models:
  Per role (implementer, reviewer, auditor), highest first: role flag (--implementer-model, --reviewer-model,
  --auditor-model) > --model > role env (BUNKER_IMPLEMENTER_MODEL, BUNKER_REVIEWER_MODEL, BUNKER_AUDITOR_MODEL)
  > BUNKER_MODEL > Claude Code's own default (no --model is passed). Env vars follow the Auth precedence below,
  so a repo's .bunker/.env can set its own defaults; models.* in .bunker/config.toml rank below the env vars. The model in use is shown when each role starts, in the run
  log, the PR body and --ui; "Claude default" when none is set.

Auth:
  Easiest: run \`bunker init\` in the repo (or \`bunker doctor\` to just check). By hand:
  Put CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`) in ~/.config/bunker/.env,
  plus optionally BUNKER_GH_TOKEN, a scoped token for bunker's own gh/git calls.
  Precedence: exported variables > <repo>/.bunker/.env > ~/.config/bunker/.env.
  --no-sandbox skips the check; claude on the host uses your normal login.

Examples:
  bunker "add a greet() helper"
  bunker --task "add greet()" --task "add farewell()"
  bunker --review "add a greet() helper" --max-rounds 3
  bunker --issue 12 --verify "bun test"
  bunker --queue --verify "bun test && bun run typecheck" --merge
  bunker --watch --for 5h --max-cost-day 10
  bunker ui
  bunker --audit --focus "error handling"
`;
