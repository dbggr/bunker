# Releasing

`bunker self-update` installs the latest `vX.Y.Z` tag, so what lands on `main` only reaches
other repos' watchers once a human tags it. (`bunker self-update --channel main` tracks `main`
instead; use it for bunker's own repo.)

Either channel first compares its target with the commit the running binary was built from
(recorded at build time). A target behind that commit (a downgrade, e.g. a `main` build ahead of
the latest tag) or diverged from it is refused with exit 2, before any watch is drained, and
nothing is rebuilt; `--force` installs it anyway with a warning. A target at the same commit
prints `already at <v>` and rebuilds nothing.

To cut a release, from a clean, up-to-date `main`:

1. Bump `version` in `package.json` to the new `X.Y.Z` (semver).
2. Run `bun run changelog`. It adds a `## vX.Y.Z` section to `CHANGELOG.md` listing the merged
   PR titles since the previous `v*` tag. Edit it by hand if needed.
3. Run `bun test`, then commit both files (`chore: release vX.Y.Z`) and merge that through a PR.
4. On the merged commit, create the tag: `git tag vX.Y.Z`.
5. A human pushes it: `git push origin vX.Y.Z`. Agents never push release tags.

Only tags of the exact form `vX.Y.Z` count; prereleases such as `v1.0.0-rc1` and other tags are
ignored. `bunker --version` shows the tag the binary was built from, or `main@<sha>`.
