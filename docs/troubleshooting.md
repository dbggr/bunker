# Troubleshooting

Each entry is symptom, cause, fix. The run log (`.bunker/runs/<N>-<timestamp>.log`) has the full output.

## Push refused: workflow changes

- **Symptom**: the push fails with a message that the token lacks `workflow` scope or refuses to update `.github/workflows/`.
- **Cause**: the issue's change edits a workflow file and `BUNKER_GH_TOKEN` has no Workflows permission, on purpose.
- **Fix**: push the kept branch by hand over SSH from the worktree, `git push -u origin <branch>`, and open the PR yourself. Don't add Workflows to the token.

## Queue misses an issue (`gh issue list` lag)

- **Symptom**: an issue you just labelled `bunker` isn't picked up, or a just-closed one still is.
- **Cause**: GitHub's issue search index lags behind label changes by seconds to minutes.
- **Fix**: wait and re-run `bunker --queue`, or run `bunker --issue N` directly. `--watch` picks it up on a later pass.

## Auto-merge is slow to fire

- **Symptom**: the PR is green but sits open for a while.
- **Cause**: GitHub evaluates auto-merge asynchronously after the last check passes.
- **Fix**: wait. It does fire. If you're in a hurry, merge the PR by hand; bunker notices it is merged.

## `ci-timeout`

- **Symptom**: status `ci-timeout`; the PR is still open.
- **Cause**: not merged within `--ci-timeout` minutes (default 30). Checks are still running, failing, or waiting on a runner.
- **Fix**: look at the PR's checks. Auto-merge is still armed, so GitHub may merge it later. For slow CI raise `--ci-timeout`. The worktree is kept; remove it with `git worktree remove` once the PR is dealt with.

## Issue relabelled `bunker-failed`

- **Symptom**: `--watch` removed `bunker` from an issue, added `bunker-failed` and left a comment.
- **Cause**: the issue ended in anything other than `merged`. It is never retried automatically, so a broken issue can't burn budget in a loop.
- **Fix**: read the comment and the run log, fix the cause (or the issue text), then relabel it `bunker` to retry.

## `node_modules` or `tsc` missing in a worktree

- **Symptom**: the agent or verify says `tsc: not found` or can't resolve modules.
- **Cause**: a worktree is a fresh checkout without installed dependencies.
- **Fix**: add the install to `.bunker/setup`, e.g. `bun install`. It runs before the agent and before verify. Commit it to the default branch.

## Python (or another tool) not in the image

- **Symptom**: `python: command not found` during the agent run or verify.
- **Cause**: the base image only has git, bash, ripgrep and claude.
- **Fix**: add a `.bunker/Dockerfile` to the repo, commit it, and install the tool there:

  ```dockerfile
  FROM bunker-claude
  USER root
  RUN apt-get update && apt-get install -y python3 python-is-python3
  ```

  Match the user the base image runs as if it differs.
