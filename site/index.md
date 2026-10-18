---
layout: home

hero:
  name: bunker
  text: Label an issue. Get back a merged pull request.
  tagline: Claude coding agents work your GitHub issues in locked-down sandboxes, a second agent reviews, your tests decide, and GitHub's required checks guard the merge.
  image:
    src: /logo.svg
    alt: bunker
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How it stays safe
      link: /guide/security
    - theme: alt
      text: GitHub
      link: https://github.com/dbggr/bunker

features:
  - icon: 🏷️
    title: You choose the work
    details: Label an issue bunker:queued. Only repo admins and maintainers can queue work, and bunker checks who added the label.
  - icon: 🔒
    title: A locked room for the agent
    details: Each issue gets its own git worktree and Docker container. The agent never sees your GitHub token or SSH keys, and the repo's git internals are read-only.
  - icon: 👀
    title: A second opinion
    details: Another agent reviews every change and sends it back with required fixes, round after round.
  - icon: ✅
    title: Your tests decide
    details: Your verify command runs in the sandbox with no network and no credentials. A failure gets one fix round, then stops.
  - icon: 🛡️
    title: GitHub guards the merge
    details: bunker only arms auto-merge when a ruleset requires a passing check. Changes to CI, bunker's config or agent instructions always wait for a person.
  - icon: 🌙
    title: Built to be left running
    details: bunker watch works the queue unattended, two at a time, with spend caps, a PR shepherd that keeps PRs green, and bunker status to check in.
---

## TL;DR: why use bunker?

- **Your backlog moves while you do something else.** Label the small, well-defined issues you never get to; come back to reviewed, tested pull requests that are already merged, or a clear reason why one couldn't be done.
- **You get AI-written code without handing over the keys.** The agent works in a sandbox with no access to your tokens or SSH keys, a second agent reviews it, and your tests and GitHub's required checks decide what merges.
- **You stay in charge.** Only you can queue work, changes to CI or bunker's own rules always wait for a person, and everything arrives as a normal PR you can read.
- **It's cheap and measurable.** About $1.29 of agent time per merged issue on bunker's own repo, with daily and monthly spend caps, and `bunker status` shows what it did and why.

**Not for you if:** your repo has no tests or CI to gate on, the work is a big redesign rather than issues you could describe in a few lines, or you don't want to read the PRs it opens.

## See it

<section class="bs center" aria-label="How it works">
  <p class="bs-kicker">How it works</p>
  <h3 class="bs-title">One issue, start to finish</h3>
  <ol class="bs-flow">
    <li class="you"><span class="n">1 · You</span><strong>Pick a job</strong><span>Label a GitHub issue for bunker.</span></li>
    <li class="bunker"><span class="n">2 · Bunker</span><strong>Check it's you</strong><span>Only maintainers can queue work.</span></li>
    <li class="ai"><span class="n">3 · AI</span><strong>Write it</strong><span>In a sandbox, on its own branch.</span></li>
    <li class="ai"><span class="n">4 · AI</span><strong>Review it</strong><span>A second agent sends it back if needed.</span></li>
    <li class="bunker"><span class="n">5 · Bunker</span><strong>Test it</strong><span>Your tests, with one fix round if red.</span></li>
    <li class="github"><span class="n">6 · GitHub</span><strong>Merge it</strong><span>Required checks pass, auto-merge lands it.</span></li>
  </ol>
  <div class="bs-pills">
    <span><b>Waits for you</b> when it changes its own rules or CI</span>
    <span><b>Flags it</b> with the reason when it can't finish</span>
  </div>
</section>

<section class="bs" aria-label="Running unattended">
  <p class="bs-kicker">Running unattended</p>
  <h3 class="bs-title">Set it watching, check in when you like</h3>
  <div class="bs-cols">
    <ul class="bs-list">
      <li style="--c: var(--bs-bunker)">Works the queue in priority order<span> · bugs first</span></li>
      <li style="--c: var(--bs-ai)">Two issues at once, each in its own sandbox</li>
      <li style="--c: var(--bs-you)">Keeps open PRs green: fixes failed checks, resolves conflicts</li>
      <li style="--c: var(--bs-stop)">Daily and monthly spend caps</li>
      <li style="--c: var(--bs-github)">A live view, desktop notifications, and <b>bunker status</b></li>
    </ul>
    <pre class="bs-term"><span class="d">$</span> bunker status
<span class="g">watcher: alive</span> · 0.1.0 · up 3h09m
&nbsp;
current run:
  #349 · implement for 10m11s
&nbsp;
queue:
  1. #363 docs: bring every doc in line… <span class="p">(bug)</span>
  2. #349 chore: remove pre-1.0 shims…
&nbsp;
spend: $44.83 in 24 h</pre>
  </div>
</section>

<section class="bs" aria-label="Safety">
  <p class="bs-kicker">Safety</p>
  <h3 class="bs-title">Built to be left alone</h3>
  <div class="bs-cols">
    <ul class="bs-list">
      <li style="--c: var(--bs-you)">Only a maintainer's label queues work; edited issues are refused</li>
      <li style="--c: var(--bs-you)">Comments from strangers never reach the agent</li>
      <li style="--c: var(--bs-ai)">The agent never sees your GitHub token or SSH keys</li>
      <li style="--c: var(--bs-ai)">The repo's git internals are read-only inside the sandbox</li>
    </ul>
    <ul class="bs-list">
      <li style="--c: var(--bs-bunker)">Tests run with no network and no credentials</li>
      <li style="--c: var(--bs-bunker)">Changes to CI, bunker's config or agent instructions wait for a person</li>
      <li style="--c: var(--bs-github)">Nothing merges without a required check on GitHub</li>
      <li style="--c: var(--bs-github)">Every safety gate has a test that fails if it breaks</li>
    </ul>
  </div>
</section>

<section class="bs" aria-label="It built itself">
  <p class="bs-kicker">It built itself</p>
  <h3 class="bs-title">Three days of bunker working on bunker</h3>
  <div class="bs-stats">
    <div style="--c: var(--bs-bunker)"><span class="v">159</span><span class="l">pull requests written and merged by bunker</span></div>
    <div><span class="v">29</span><span class="l">written by hand: the first spike, the security fixes and the docs</span></div>
    <div style="--c: var(--bs-ok)"><span class="v">820</span><span class="l">tests guarding about 10,300 lines of code</span></div>
    <div style="--c: var(--bs-ai)"><span class="v">$1.29</span><span class="l">average agent cost per merged issue</span></div>
  </div>
  <p class="bs-note">178 CI runs on main, 3 red (all during one flaky-test window, since fixed), 0 reverts. Numbers from the repo's own run logs and GitHub history on 2026-10-19.</p>
</section>

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/dbggr/bunker/main/install.sh | sh
```

The installer checks git, Bun, Docker, the GitHub CLI and Claude Code first, and never installs them for you; it links each missing one's install page.

## Your first issue

```sh
cd your-repo
bunker init          # tokens, setup and verify commands, sandbox image, labels
bunker doctor        # every ✓ and ✗, with the fix for each ✗
bunker issue 12      # one issue, start to finish, and watch it work
bunker watch         # then work everything labelled bunker:queued, unattended
```

## Built with bunker

In its first three days bunker wrote and merged **159 of its own pull requests** (29 more were written by hand), with 820 tests and no reverts on main, at roughly **$1.29 of agent time per merged issue** (as of 2026-10-19). The numbers and the failures, from an earlier snapshot, are in the [v1.0 readiness review](https://github.com/dbggr/bunker/blob/main/release/v1-readiness.md).

::: tip Pre-1.0
bunker works its own repository every day, but flags, config keys and labels can still change before 1.0.
:::

bunker was inspired by Matt Pocock's [sandcastle](https://github.com/mattpocock/sandcastle), a toolkit for building agent loops. bunker is one opinionated loop, from issue to merged PR, with the queue, review, merge and unattended safety built in.
