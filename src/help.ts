export const HELP = `bunker - run coding agents in sandboxed git worktrees

Usage:
  bunker "<prompt>" [options]                 single prompt: one agent run, merged back
  bunker --task "<p>" --task "<p>" ...        parallel: one worktree per task
  bunker --review "<prompt>"                  implement -> review -> fix rounds
  bunker --issue <n>                          GitHub issue -> reviewed PR
  bunker --queue                              work the \`bunker\` label queue
  bunker --audit                              file improvement ideas as \`discovered\` issues

Common options (all modes):
  --model <id>               agent model
  --image <name>             use this docker image as-is
  --no-sandbox               run the agent on the host instead of in docker
  -h, --help                 show this help (wins over every other flag)
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
  --queue                    run open issues labelled \`bunker\`, oldest first
  --limit <n>                (--queue) max issues per run (default 5)
  --setup "<cmd>"            run in the worktree before the agent (default: .bunker/setup)
  --verify "<cmd>"           run after approval; a failure stops before pushing
  --verify-on-host           run --verify on the host instead of in the sandbox
  --merge                    auto-merge the PR once checks pass (requires --verify)
  --ci-timeout <min>         (--merge) minutes to wait for the merge (default 30)

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
  bunker --audit --focus "error handling"
`;
