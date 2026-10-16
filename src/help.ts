export const HELP = `bunker - run coding agents in sandboxed git worktrees

Usage:
  bunker "<prompt>" [options]                 single prompt: one agent run, merged back
  bunker --task "<p>" --task "<p>" ...        parallel: one worktree per task
  bunker --review "<prompt>"                  implement -> review -> fix rounds
  bunker --issue <n>                          GitHub issue -> reviewed PR
  bunker --queue                              work the \`bunker\` label queue
  bunker --watch                              keep working the queue unattended (implies --queue --merge)
  bunker ui [--port <n>]                      shared live view: one tab per repo (default port 4321)
  bunker --audit                              file improvement ideas as \`discovered\` issues

Common options (all modes):
  --model <id>               agent model
  --image <name>             use this docker image as-is
  --no-sandbox               run the agent on the host instead of in docker
  -h, --help                 show this help (wins over every other flag)
  --verbose                  stream all agent, setup and verify output (also BUNKER_VERBOSE=1)
  --version                  print the version

Single prompt and --task:
  --max-iterations <n>       re-run the agent up to n times in one worktree (default 1)
  --task "<prompt>"          repeatable; each task gets its own worktree

--review, --issue, --queue:
  --review                   implement -> review -> fix a single prompt
  --max-rounds <n>           review rounds before giving up (default 2)
  --reviewer-model <id>      model for the reviewer (default: --model)

--issue and --queue:
  --issue <n>                implement GitHub issue n and open a PR
  --queue                    run open issues labelled \`bunker\`, oldest first; skips any with an open
                             \`Blocked by #N\` / \`Depends on #N\`. An agent that prints <blocked-by title="…">…</blocked-by>
                             gets its blocker filed as \`discovered\` and the issue relabelled \`bunker-blocked\`
                             (no PR, doesn't count toward --limit); it returns to \`bunker\` once the blockers close
                             skips issues with an open \`Blocked by #N\` / \`Depends on #N\`; an agent that prints
                             <blocked-by> files the blocker as \`discovered\` and the issue becomes \`bunker-blocked\`,
                             back to \`bunker\` once its blockers close
  --limit <n>                (--queue) max issues per run (default 5; blocked issues don't count)
  --setup "<cmd>"            run in the worktree before the agent (default: .bunker/setup)
  --verify "<cmd>"           run after approval; a failure stops before pushing (default: .bunker/verify)
  --verify-on-host           run --verify on the host instead of in the sandbox
  --merge                    auto-merge the PR once checks pass (requires --verify or .bunker/verify)
  --ci-timeout <min>         (--merge) minutes to wait for the merge (default 30)

--issue, --queue, --watch, live view:
  Every run publishes to a bunker hub (bunker ui) if one is reachable on 127.0.0.1:4321,
  tagged with the repo (owner/repo from origin); with no hub it just carries on.
  --ui                       make sure a hub is up (start one for this run if not), publish, print the URL
  --port <n>                 (--ui) hub port to use (default 4321)
  --ui-keep                  (--ui) keep the hub this run started alive after it ends (Ctrl-C to quit)

--watch:
  --watch                    loop: work the queue, sleep, repeat until Ctrl-C; needs --verify or .bunker/verify
  --interval <min>           minutes between passes (default 10)
  --for <duration>           stop starting new issues after this long, e.g. 5h, 90m, 2h30m (default: until Ctrl-C)
  --max-cost <usd>           spend cap per rolling 24 h, kept in .bunker/watch-spend.json (default 20)
  Failed issues get \`bunker-failed\` instead of \`bunker\` and are never retried automatically.

--audit:
  --audit                    read-only agent run that files issues
  --max-issues <n>           max issues to file (default 5)
  --focus "<text>"           steer the audit toward a topic
  --setup "<cmd>"            run in the worktree before the agent

Auth:
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
  bunker --watch --for 5h --max-cost 10
  bunker ui
  bunker --audit --focus "error handling"
`;
