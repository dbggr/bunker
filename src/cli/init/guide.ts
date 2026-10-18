/** What each `bunker init` step is for; `bunker init --explain <step>` re-reads it. */
export interface StepGuide {
  id: string;
  title: string;
  /** One line: why this step matters. */
  why: string;
  /** The longer guidance printed by --explain. */
  details: string[];
}

export const STEPS: StepGuide[] = [
  {
    id: "welcome",
    title: "Welcome",
    why: "so you know what bunker does and what it will touch before it touches anything.",
    details: [
      "bunker turns a labelled GitHub issue into a reviewed, tested pull request: a Claude agent works in a sandboxed git worktree, a second agent reviews it, and your verify command must pass before anything is pushed.",
      "It needs: Docker (the sandbox), git, the GitHub CLI (`gh`, logged in), a Claude subscription or API key, and a fine-grained GitHub token scoped to this one repo.",
      "It writes into the repo: .bunker/config.toml (setup and verify commands) and .bunker/Dockerfile (the sandbox's toolchain); you commit both. Tokens go to ~/.config/bunker/.env (mode 0600), never into the repo.",
      "Rough cost: a small issue is roughly $1-$5 of Claude usage. Step 7 sets a daily spending cap.",
    ],
  },
  {
    id: "claude",
    title: "Claude token",
    why: "the agents run on your Claude subscription (or API key); without it nothing can start.",
    details: [
      "Run `claude setup-token` (Claude Code CLI); it prints a long-lived token. Paste it when asked: input is hidden and stored in ~/.config/bunker/.env with mode 0600.",
      "Prefer an API key? Put ANTHROPIC_API_KEY=... in ~/.config/bunker/.env instead.",
      "Install Claude Code first if needed: https://docs.claude.com/en/docs/claude-code/setup",
    ],
  },
  {
    id: "github",
    title: "GitHub identity",
    why: "bunker pushes branches and opens PRs with a token that can do only that, not everything you can.",
    details: [
      "Create a fine-grained personal access token for this one repository, with a short expiry:",
      "  Contents: Read and write        (push the agent's branch)",
      "  Pull requests: Read and write   (open, update and merge the PR)",
      "  Issues: Read and write          (read the task, label and comment on it)",
      "  Metadata: Read                  (added automatically)",
      "  Actions: Read                   (see whether CI passed)",
      "  Workflows: NO                   (so an agent can never change your CI to pass itself)",
      "Create it at https://github.com/settings/personal-access-tokens/new (bunker pre-fills the name and permissions in the link it prints).",
      "Advanced, skipped by default: act as a GitHub App or a separate bot account instead, for separate PR attribution (docs/getting-started.md).",
    ],
  },
  {
    id: "toolchain",
    title: "Toolchain",
    why: "bunker has to know how to install and test your project to check the agent's work.",
    details: [
      "`setup` installs dependencies in each fresh worktree (for example `npm ci`). `verify` is the command that must pass before anything is pushed (for example `npm test`).",
      "bunker looks at package.json and lockfiles (npm, pnpm, yarn, bun), composer.json, pyproject.toml / requirements.txt, Cargo.toml and go.mod. When it can't tell, or the repo is a monorepo, it asks instead of guessing.",
      "Both commands live in .bunker/config.toml; edit them there any time.",
    ],
  },
  {
    id: "sandbox",
    title: "Sandbox image",
    why: "verify runs code an agent wrote, so it runs in a container with no network; better to find out now that it works there.",
    details: [
      "bunker builds the base image plus .bunker/Dockerfile, then runs `setup` (with network, to install) and `verify` (isolated, no network) once in a throwaway worktree, exactly as an unattended run will.",
      "If it fails you see the tail of the output and can edit the commands or add a line to the Dockerfile (for example `RUN apt-get install -y make`) and retry.",
    ],
  },
  {
    id: "merge",
    title: "Merge safety",
    why: "bunker only merges what a required CI check has passed; that rule must live on GitHub, not in the agent.",
    details: [
      "CI: a workflow with a job named `test` that runs your tests. bunker can write one for the detected toolchain as a commit on a branch with a pull request, never straight to your default branch.",
      "Ruleset (GitHub's newer branch protection): a rule that requires the `test` check before merging. A required check in classic branch protection (Settings -> Branches) counts too, but bunker --merge can only read it if its token has Administration: read.",
      "bunker creates the ruleset through your own `gh` login, or prints the exact clicks (Settings -> Rules -> Rulesets -> New branch ruleset -> Require status checks to pass -> add `test`).",
      "If the repo's settings are managed by IaC (terraform, probot settings), change them there; a UI edit would be reverted.",
    ],
  },
  {
    id: "spend",
    title: "Spend and models",
    why: "agents run unattended, so a daily cap keeps a stuck loop from running up a bill.",
    details: [
      "Caps are notional USD (what `claude -p` reports) over a rolling window; `bunker watch` pauses when one is reached. Default: $20 a day; a monthly cap is optional.",
      "Models: opus is the strongest and costliest, sonnet is balanced and cheaper, haiku is the cheapest and best for simple tasks. Blank keeps Claude's default.",
      "Caps go in ~/.config/bunker/config.toml (max_cost_day, max_cost_month).",
    ],
  },
  {
    id: "labels",
    title: "Labels and first task",
    why: "labels are how you hand work to bunker and how it reports back; a first task shows you one loop end to end.",
    details: [
      "bunker creates the labels it uses (bunker:queued, bunker:in-progress, bunker:failed, ...) with `gh label create`, using your own login.",
      "Then it can create a tiny 'hello bunker' issue and run `bunker issue <n>` while you watch, without auto-merge, so you review the PR yourself.",
    ],
  },
];

/** Finds a step by number (1-8), id or a word of its title. */
export function findStep(query: string): { index: number; guide: StepGuide } | undefined {
  const q = query.trim().toLowerCase();
  const n = Number(q);
  let index = Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n - 1 : STEPS.findIndex((s) => s.id === q || s.title.toLowerCase() === q);
  if (index < 0) index = STEPS.findIndex((s) => q.length >= 3 && (s.id.startsWith(q) || s.title.toLowerCase().includes(q)));
  return index < 0 ? undefined : { index, guide: STEPS[index]! };
}
