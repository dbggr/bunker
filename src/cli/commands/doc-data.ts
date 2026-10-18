/** Structured reference data for docs/cli.md (see scripts/cli-docs.ts). `bunker --help` stays the prose in help.ts; test/docs.test.ts checks this covers it. */

export type Row = [flag: string, what: string, dflt?: string];
export interface CommandDoc {
  cmd: string;
  summary: string;
  rows: Row[];
  example: string;
}
export interface Section {
  title: string;
  commands: CommandDoc[];
}

export const SECTIONS: Section[] = [
  {
    title: "Setup",
    commands: [
      {
        cmd: "init",
        summary: "guided first-run setup in 8 steps",
        rows: [
          ["`bunker init`", "interactive, per repo, with a progress line: [1/8] Welcome, [2/8] Claude token (via `claude setup-token`, validated), [3/8] GitHub identity (the exact fine-grained token checklist and a pre-filled link; hidden input, validated live, stored 0600 in ~/.config/bunker/.env; a GitHub App or bot account is offered as advanced), [4/8] Toolchain (npm/pnpm/yarn/bun, composer, python, cargo, go, monorepos; asks when unsure; setup and verify are editable), [5/8] Sandbox image (builds it and runs setup and verify once as an unattended run will, isolated; offers to edit and retry on failure), [6/8] Merge safety (offers a CI workflow with a `test` job as a PR, a ruleset requiring it, and auto-merge, through your own gh login; or prints the exact clicks), [7/8] Spend and models (daily cap, default $20, in ~/.config/bunker/config.toml), [8/8] Labels, then an optional guided first task: a tiny issue run attended without --merge. Nothing is written before a confirm that names the file or setting; every question shows its default. Re-running skips what is already ✓ and says so; Ctrl-C leaves no half-written files. Ends with doctor, a summary of what was written and what is still ✗, and the first command to run. NO_COLOR is honoured; links are clickable where the terminal allows"],
          ["`--yes`", "accept every default without asking; never overwrites a file, opens no PR and changes no repo setting; the steps that need you (secrets, CI, ruleset) are listed at the end"],
          ["`--explain <step>`", "re-read one step's guidance (a number 1-8 or a name: welcome, claude, github, toolchain, sandbox, merge, spend, labels)"],
          ["`-- init`", 'a one-word prompt "init" or "doctor" is read as the subcommand; to use it as a prompt put `--` first: `bunker -- init` (or make it longer than one word)'],
        ],
        example: "bunker init --yes",
      },
      {
        cmd: "doctor",
        summary: "read-only setup check, ✓/✗ with a fix for each",
        rows: [
          ["`bunker doctor`", "read-only, safe to re-run: checks tools (docker, git, gh, claude), auth (Claude token, scoped BUNKER_GH_TOKEN and the permissions it lacks), repo files, GitHub labels / auto-merge / CI / required check, the model per role, and the effective value and source of every .bunker/config.toml key (config.toml is validated). Prints ✓/✗ with a one-line fix; exit 1 if anything required is missing"],
        ],
        example: "bunker doctor",
      },
      {
        cmd: "self-update",
        summary: "build and install the latest v* release tag",
        rows: [["`--channel main`", "pull main instead of the latest v* release tag", "latest v* tag"]],
        example: "bunker self-update --channel main",
      },
    ],
  },
  {
    title: "Run work",
    commands: [
      {
        cmd: '"<prompt>"',
        summary: "single prompt: one agent run, merged back",
        rows: [["`--max-iterations <n>`", "re-run the agent up to n times in one worktree", "1"]],
        example: 'bunker "add a greet() helper"',
      },
      {
        cmd: "task",
        summary: "parallel: one worktree per task",
        rows: [
          ['`bunker task "<p>" "<p>" ...`', 'each prompt is a task with its own worktree (`task "<prompt>" "<prompt>" ...`)'],
          ["`--max-iterations <n>`", "re-run the agent up to n times in one worktree", "1"],
          ["`--no-resume`", "start every pass in a fresh agent session instead of resuming the previous one with the reviewer feedback"],
        ],
        example: 'bunker task "add greet()" "add farewell()"',
      },
      {
        cmd: "review",
        summary: "implement -> review -> fix rounds",
        rows: [
          ["`--max-rounds <n>`", "review rounds before giving up", "2"],
          ["`--reviewer-model <id>`", "model for the reviewer"],
          ["`--no-resume`", "start every implementer round (and --max-iterations pass) in a fresh agent session instead of resuming the previous one with the reviewer feedback"],
        ],
        example: 'bunker review "add a greet() helper" --max-rounds 3',
      },
      {
        cmd: "issue",
        summary: "GitHub issue -> reviewed PR",
        rows: [
          ["`issue <n>`", "implement GitHub issue n and open a PR"],
          ...pipelineRows(),
          ["`--max-rounds <n>`, `--reviewer-model <id>`, `--no-resume`", "as for `review`", "2 rounds"],
          ...hubRows(),
        ],
        example: 'bunker issue 12 --verify "bun test"',
      },
      {
        cmd: "queue",
        summary: "work the `bunker:queued` label queue",
        rows: [
          ["`queue`", "run open issues labelled `bunker:queued`, in order: `priority:high`, `priority:medium`, no priority, `priority:low`; within a priority `bug` issues first; then oldest first (watch re-orders between issues). Prints the order with the reason per issue. Skips any with an open `Blocked by #N` / `Depends on #N`. An agent that reports a blocked_by item in its <report>/<verdict> JSON gets its blocker filed as `discovered` and the issue relabelled `bunker-blocked` (no PR, doesn't count toward --limit); it returns to `bunker:queued` once the blockers close"],
          ["`--limit <n>`", "max issues per run (blocked issues don't count)", "5"],
          ["`--parallel <n>`", "(queue --merge, watch, manual-merge mode) work up to n issues at once, one worktree + container each. Merges stay serial, in queue order: each PR's branch is first updated to the latest default branch and re-verified; a conflict or failure then gets one fresh attempt from the new main. Trade-off: more concurrent spend, and rework when issues touch the same files; 2 is a good choice", "1"],
          ...pipelineRows(),
          ["`--max-rounds <n>`, `--reviewer-model <id>`, `--no-resume`", "as for `review`", "2 rounds"],
          ...hubRows(),
        ],
        example: 'bunker queue --verify "bun test && bun run typecheck" --merge',
      },
      {
        cmd: "watch",
        summary: "keep working the queue unattended (implies --merge)",
        rows: [
          ["`watch`", "loop: work the queue, sleep, repeat until Ctrl-C; needs --verify or verify in config.toml"],
          ["`--interval <min>`", "minutes to sleep when no work is waiting", "10"],
          ["`--for <duration>`", "stop starting new issues after this long, e.g. 5h, 90m, 2h30m", "until Ctrl-C"],
          ["`--no-notify`", "no desktop notifications (notify-send / osascript) for: paused on the usage limit, spend cap reached, an issue failed or blocked, a pass that merged, watch stopped or crashed. Failed / blocked comments @-mention notify.github_user (default: the repo owner, if a user account)"],
          ["`--max-cost-day <usd>`", "stop starting issues once this much (notional USD, as `claude -p` reports it) was spent in a rolling 24 h, then sleep until the window frees up; kept in .bunker/watch-spend.json. Also max_cost_day in ~/.config/bunker/config.toml", "no cap"],
          ["`--max-cost-month <usd>`", "same for a rolling 30 days (config.toml: max_cost_month)", "no cap"],
          ["`--audit-every <days>`", "also run audit at most once per this many days, kept in .bunker/watch-state.json (30 is a good value)", "off"],
          ["`--triage-every <hours>`", "also run triage at most once per this many hours, comment and close only", "off"],
          ["`--no-merge`", "manual-merge mode (also `merge = \"manual\"` in config.toml): a run ends at an open PR labelled `bunker:awaiting-review` and a notification; auto-merge is never requested and bunker never merges. Issues with an open bunker PR are not started again"],
          ["`--parallel <n>`", "as for `queue`", "1"],
          ...pipelineRows(),
          ["`--max-rounds <n>`, `--reviewer-model <id>`, `--no-resume`", "as for `review`", "2 rounds"],
          ...hubRows(),
          ["shepherd stage", "Under watch a run ends once its PR is open and auto-merge is armed, which frees the --parallel slot. The shepherd (the same stage as `bunker shepherd`) then owns every open bunker PR (same-repo branch {feature|fix}/<n>-*, body \"Closes #<n>\") on each pass. It keeps no state: it reads GitHub, so it carries on after a restart. A red required check goes, with its failed log, to a fix agent on the PR branch (3 attempts, then `bunker:failed` on the PR and a notification; reading logs needs Actions: read on BUNKER_GH_TOKEN, else it notifies you); a branch behind its base is updated; a conflict is resolved by an agent, verified, and reviewed again if the diff changed; \"changes requested\" by a maintainer goes to the agent and the review is re-requested. It never merges: auto-merge plus a required check is the gate"],
          ["failed issues", "Failed issues get `bunker:failed` instead of `bunker:queued` and are never retried automatically; a running one shows `bunker:in-progress`"],
        ],
        example: "bunker watch --for 5h --max-cost-day 10",
      },
    ],
  },
  {
    title: "PRs",
    commands: [
      {
        cmd: "shepherd",
        summary: "one pass over the open bunker PRs: fix red CI, update behind branches, resolve conflicts",
        rows: [["`bunker shepherd`", "one pass of the stage `watch` runs on every pass; see the shepherd stage under `watch`"]],
        example: "bunker shepherd",
      },
    ],
  },
  {
    title: "Monitor",
    commands: [
      {
        cmd: "status",
        summary: "read-only watch summary: watcher, current run, queue, merged/failed with reasons, spend",
        rows: [
          ["`bunker status`", "read-only, run in the repo. Prints whether `bunker watch` is alive (from .bunker/watch.lock: pid, version, uptime), the run in flight and its stage, the queue in priority order, what merged and failed since the watcher started (each failure with a one-line reason from its run log, the PR or log, and the `gh issue edit` command that retries it), and spend in the last 24 h and 30 days against the caps. With no watcher running it shows the last run's results"],
          ["`--json`", "print the same as JSON"],
        ],
        example: "bunker status --json",
      },
      {
        cmd: "ui",
        summary: "shared live view: one tab per repo",
        rows: [["`--port <n>`", "hub port to use", "4321"]],
        example: "bunker ui",
      },
    ],
  },
  {
    title: "Find work",
    commands: [
      {
        cmd: "audit",
        summary: "file improvement ideas as `discovered` issues",
        rows: [
          ["`audit`", "read-only agent run that files issues"],
          ["`--max-issues <n>`", "max issues to file; only high/medium severity are filed, as `discovered` + `severity:*`", "5"],
          ["`--focus \"<text>\"`", "steer the audit toward a topic"],
          ['`--setup "<cmd>"`', "run in the worktree before the agent"],
          ["`--no-pull`, `--ui`, `--port <n>`, `--ui-keep`", "as for `issue`"],
        ],
        example: 'bunker audit --focus "error handling"',
      },
      {
        cmd: "triage",
        summary: "read-only agent verifies open `discovered` issues (dry run unless --yes)",
        rows: [
          ["`triage`", "read-only agent (same sandbox as audit) checks each open `discovered` issue without a triage comment against the default branch: fixed, as-designed, duplicate or valid (with a suggested priority and bug). Bunker posts the verdict as a comment, sanitised and redacted. Dry run by default: prints verdicts and planned actions, changes nothing. Failed or unparseable verdicts leave the issue untouched"],
          ["`--yes`", "comment and close fixed / duplicate issues (as-designed: closed not planned), and label valid ones bunker:queued + priority:* + bug as you. Valid issues are never labelled bunker:queued without --yes", "dry run"],
          ["`--limit <n>`", "max issues per run, oldest first", "10"],
          ["`watch --triage-every`", "runs triage unattended in comment-and-close mode only: it never labels"],
        ],
        example: "bunker triage --yes",
      },
    ],
  },
  {
    title: "Maintenance",
    commands: [
      {
        cmd: "clean",
        summary: "remove leftover worktrees and branches (dry run unless --yes)",
        rows: [
          ["`bunker clean`", "run from the repo's main checkout. Dry run by default: prints what it would remove and why. Worktrees: .worktrees/<n>-* whose issue is closed or whose PR is merged/closed; /tmp/bunker-* worktrees of this repo that no running process uses. Branches: bunker/<id> without a worktree; {feature|fix}/<n>-<slug> whose PR is merged/closed or that have no commits beyond origin/<default>. Anything with commits not on origin/<default>, or uncommitted changes, is first kept as the tag bunker/stale/<name>-<timestamp> (printed). Only bunker's own names are touched. Ends with git worktree prune"],
          ["`--yes`", "really remove", "dry run"],
          ["`--logs <days>`", "also remove .bunker/runs/*.log older than this", "clean.logs_days from config, else keep all"],
          ["`--images`", "also remove bunker-repo-* docker images no running container uses (bunker-claude is kept)"],
          ["`--force`", "go ahead although a watch lock for this repo is held by a live process (otherwise exit 2)"],
          ["start-up cleanup", "issue, queue and watch run the same worktree and branch cleanup at start-up, and Ctrl-C/SIGTERM removes the current run's /tmp/bunker-* worktree and bunker/<id> branch if it has no commits"],
        ],
        example: "bunker clean --yes --logs 14",
      },
    ],
  },
];

function pipelineRows(): Row[] {
  return [
    ['`--setup "<cmd>"`', "run in the worktree before the agent", "setup in config.toml"],
    ['`--verify "<cmd>"`', "run after approval; a failure stops before pushing", "verify in config.toml"],
    ["`--verify-on-host`", "run --verify on the host instead of in the sandbox"],
    ["`--merge`", "auto-merge the PR once checks pass (requires --verify or verify in config.toml)"],
    ["`--ci-timeout <min>`", "(--merge) minutes to wait for the merge; under watch the shepherd waits, not the run", "30"],
    ["`--allow-labeler <login>`", '(repeatable) also accept the `bunker:queued` label from this GitHub user. By default only repo admins and maintainers may queue work: otherwise the issue is skipped, the label removed and a comment left. An issue never labeled "bunker:queued" is refused too (no label event to check): add the label first. Also: allow_labelers = ["login"] in ~/.config/bunker/config.toml. If the permission lookup fails the issue is skipped (fail closed)'],
  ];
}

function hubRows(): Row[] {
  return [
    ["`--no-pull`", "skip the `git pull --ff-only` of your checkout that otherwise runs first, only when it has no tracked changes and is on the default branch (issue, queue, watch, audit)"],
    ["`--ui`", "every run publishes to a bunker hub (`bunker ui`) if one is reachable on 127.0.0.1:4321, tagged with the repo (owner/repo from origin); with no hub it just carries on. `--ui` makes sure a hub is up (start one for this run if not), publish, print the URL"],
    ["`--port <n>`", "(--ui) hub port to use", "4321"],
    ["`--ui-keep`", "(--ui) keep the hub this run started alive after it ends (Ctrl-C to quit)"],
  ];
}

export const COMMON_FLAGS: Row[] = [
  ["`--model <id>`", "model for every role (implementer, reviewer, auditor)", "Claude Code's default"],
  ["`--implementer-model <id>`", "model for the implementer"],
  ["`--auditor-model <id>`", "model for the audit agent"],
  ["`--reviewer-model <id>`", "model for the reviewer (review, issue, queue, watch)"],
  ["`--image <name>`", "use this docker image as-is"],
  ["`--no-sandbox`", "run the agent on the host (empty HOME, no isolation); skips the auth check, claude on the host uses your normal login"],
  ["`-h`, `--help`", "show help (wins over every other flag)"],
  ["`--verbose`", "stream all agent, setup and verify output (also BUNKER_VERBOSE=1)"],
  ["`--version`", "print the version and the tag (or main@<sha>) it was built from"],
  ["`--max-rounds <n>`", "review rounds before giving up (review, issue, queue, watch)", "2"],
  ["`--parallel <n>`", "issues worked at once (queue --merge, watch)", "1"],
  ['`--verify "<cmd>"`', "run after approval (issue, queue, watch)", "verify in config.toml"],
  ["`--idle-timeout <min>`", "kill an agent or reviewer that prints nothing for this long; the step fails as idle-timeout, worktree and branch kept", "10"],
  ["`--completion-timeout <s>`", "seconds an agent may linger after its final result event or closing signal before it is killed and the step counts as done, with a warning", "60"],
  ["`--step-timeout <min>`", "overall limit for setup and verify, which can be quiet for long", "30"],
];

/** Models precedence, auth precedence and the legacy copy file: reference rows, no help prose. */
export const MODEL_ROWS: Row[] = [
  ["Per role", "(implementer, reviewer, auditor), highest first: role flag (--implementer-model, --reviewer-model, --auditor-model) > --model > role env (BUNKER_IMPLEMENTER_MODEL, BUNKER_REVIEWER_MODEL, BUNKER_AUDITOR_MODEL) > BUNKER_MODEL > Claude Code's own default (no --model is passed). Env vars follow the auth precedence, so a repo's .bunker/.env can set its own defaults; models.* in .bunker/config.toml rank below the env vars. The model in use is shown when each role starts, in the run log, the PR body and --ui; \"Claude default\" when none is set", "Claude default"],
];
export const AUTH_ROWS: Row[] = [
  ["`CLAUDE_CODE_OAUTH_TOKEN`", "from `claude setup-token`, in ~/.config/bunker/.env. Easiest: run `bunker init` in the repo (or `bunker doctor` to just check)"],
  ["`BUNKER_GH_TOKEN`", "optional scoped token for bunker's own gh/git calls"],
  ["precedence", "exported variables > <repo>/.bunker/.env > ~/.config/bunker/.env"],
];

export const CONFIG_INTRO: Row[] = [
  ["precedence", "CLI flag > env var > config.toml > .bunker/copy > built-in default"],
  ["errors", "A leftover .bunker/setup or .bunker/verify file is an error: move it into config.toml. Unknown keys warn; a key of the wrong type exits 2"],
  ["tables", "[models], [skills], [watch], [merge], [clean], [notify], [services.<name>]"],
];

export const EXTRA_KEYS: { key: string; what: string; dflt: string; file: string }[] = [
  { key: "allow_labelers", what: 'GitHub logins also accepted as `bunker:queued` labelers (same as repeatable --allow-labeler); user-level only, a repo file cannot widen its own gate. e.g. `["login"]`', dflt: "none", file: "~/.config/bunker/config.toml" },
  { key: "max_cost_day", what: "USD cap per rolling 24 h (same as --max-cost-day)", dflt: "no cap", file: "~/.config/bunker/config.toml" },
  { key: "max_cost_month", what: "USD cap per rolling 30 days (same as --max-cost-month)", dflt: "no cap", file: "~/.config/bunker/config.toml" },
  { key: "`[services.<name>]`", what: "a service (e.g. Postgres) started for each verify attempt and removed afterwards; verify reaches it at the host name <name> and nothing else on the network. Keys: image (required), env (table of strings), healthcheck (shell command run in the service; verify waits until it exits 0). Each attempt gets fresh containers on its own internal network, so parallel runs share nothing. Needs the docker or podman sandbox. verify runs agent-written code that can talk to the services: keep their credentials throwaway, never real ones. With services, verify joins their internal network, so verify_network adds the Claude credentials but no internet. Example: `[services.database] image = \"postgres:18-alpine\" healthcheck = \"pg_isready -U app\"`", dflt: "none", file: ".bunker/config.toml" },
  { key: "`.bunker/copy`", what: "legacy, same as copy in config.toml: gitignored files to copy from your checkout into each worktree before setup (e.g. .env): one path or glob per line, `#` comments; directories are copied recursively, missing paths warn. Paths outside the repo (`..`, absolute) are rejected. Copied files are never committed (a commit that includes one fails the run) and the values of copied .env* files are redacted from output. Library option: copyToWorktree: string[] overrides the file", dflt: "none", file: ".bunker/copy" },
];

export const LABELS: [label: string, meaning: string][] = [
  ["`bunker:queued`", "set by you (or `triage --yes`) to queue an issue for `queue` / `watch`; by default only repo admins and maintainers may set it (see `--allow-labeler`). Returns once the blockers of a `bunker-blocked` issue close"],
  ["`bunker:in-progress`", "set while a run works the issue"],
  ["`bunker:failed`", "set on a failed issue instead of `bunker:queued`, never retried automatically; also set on a PR after 3 failed shepherd fix attempts"],
  ["`bunker:awaiting-review`", "set on an open PR in manual-merge mode (`--no-merge`, `merge = \"manual\"`); bunker never merges it"],
  ["`bunker:review`", "set on a PR whose changes a human must review (bunker leaves auto-merge off); the shepherd leaves it for a human to merge"],
  ["`bunker-blocked`", "set on an issue whose agent reported a blocked_by item; its blocker is filed as `discovered`"],
  ["`discovered`", "set by `audit` on issues it files (with `severity:*`); `triage` checks them"],
  ["`priority:high`, `priority:medium`, `priority:low`", "order the queue; no priority sits between medium and low; `bug` issues go first within a priority"],
];

export const EXAMPLES = [
  'bunker "add a greet() helper"',
  'bunker task "add greet()" "add farewell()"',
  'bunker review "add a greet() helper" --max-rounds 3',
  'bunker issue 12 --verify "bun test"',
  'bunker queue --verify "bun test && bun run typecheck" --merge',
  "bunker watch --for 5h --max-cost-day 10",
  "bunker ui",
  "bunker triage",
  "bunker triage --yes",
  'bunker audit --focus "error handling"',
];
