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
- **It's cheap and measurable.** About $1.15 of agent time per merged issue on bunker's own repo, with daily and monthly spend caps, and `bunker status` shows what it did and why.

**Not for you if:** your repo has no tests or CI to gate on, the work is a big redesign rather than issues you could describe in a few lines, or you don't want to read the PRs it opens.

## See it

![How it works: you label an issue, bunker checks it's you, an AI writes it in a sandbox, a second AI reviews it, your tests run, and GitHub's required checks merge it](/slides/how-it-works.webp)

![Running unattended: priority queue with bugs first, two issues at once, a PR shepherd, spend caps, and bunker status](/slides/unattended.webp)

![Safety: the label gate, untrusted comments filtered, no credentials in the sandbox, read-only git internals, isolated tests, and human review for CI and config changes](/slides/safety.webp)

![It built itself: 147 pull requests written and merged by bunker, 699 tests, about $1.15 per merged issue](/slides/built-itself.webp)

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

In its first two days bunker wrote and merged **147 of its own pull requests** (23 more were written by hand), with about 700 tests and no reverts on main, at roughly **$1.15 of agent time per merged issue**. The numbers and the failures are in the [v1.0 readiness review](https://github.com/dbggr/bunker/blob/main/release/v1-readiness.md).

::: tip Pre-1.0
bunker works its own repository every day, but flags, config keys and labels can still change before 1.0.
:::

bunker was inspired by Matt Pocock's [sandcastle](https://github.com/mattpocock/sandcastle), a toolkit for building agent loops. bunker is one opinionated loop, from issue to merged PR, with the queue, review, merge and unattended safety built in.
