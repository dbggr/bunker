# Contributing to bunker

Thanks for helping. bunker is small and opinionated, so open an issue to talk about a change before you build anything large.

## Development setup

```sh
git clone https://github.com/dbggr/bunker && cd bunker
bun install
bun test               # the whole suite; tests that need Docker skip themselves when Docker isn't running
bun run typecheck
bun run build          # dist/bunker
```

Tests never touch real GitHub, Docker images you own, desktop notifications or the network: they use fakes on `PATH`, and a guard test fails if one slips through. Keep it that way.

## How changes are made

- **One issue, one PR.** Branch as `feature/<issue>-<slug>`, `fix/<issue>-<slug>`, `docs/…` or `chore/…`, and put `Closes #<issue>` in the PR body.
- **Tests first.** Write the failing test, then the change. A bug fix comes with the test that would have caught it.
- **Conventional Commits** for commits and PR titles (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`; `feat!:` for breaking changes).
- **Docs stay in sync.** `docs/cli.md` is generated: run `bun run docs:cli` after changing `--help`. The docs tests check that every doc is linked from the README and that every flag they mention exists.
- **CI must be green** (the `test` job). Pre-1.0, breaking changes are allowed when they make bunker simpler; say so in the PR.

## bunker builds bunker

Most PRs here are written by bunker itself. Only maintainers can queue work with the `bunker:queued` label, so adding the label to your own issue does nothing. A maintainer may queue an issue you open, and bunker may then open the PR. Hand-written PRs are reviewed the same way.

## Security

Never report a security problem in a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
