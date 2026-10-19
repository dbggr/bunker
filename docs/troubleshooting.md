# Troubleshooting

Each entry is symptom, cause, fix. The run log (`.bunker/runs/<N>-<timestamp>.log`) has the full output.

## Push refused: workflow changes

- **Symptom**: the push fails with a message that the token lacks `workflow` scope or refuses to update `.github/workflows/`.
- **Cause**: the issue's change edits a workflow file and `BUNKER_GH_TOKEN` has no Workflows permission, on purpose.
- **Fix**: push the kept branch by hand over SSH from the worktree, `git push -u origin <branch>`, and open the PR yourself. Don't add Workflows to the token.

## Queue misses an issue (`gh issue list` lag)

- **Symptom**: an issue you just labelled `bunker:queued` isn't picked up, or a just-closed one still is.
- **Cause**: GitHub's issue search index lags behind label changes by seconds to minutes.
- **Fix**: wait and re-run `bunker queue`, or run `bunker issue N` directly. `bunker watch` picks it up on a later pass.

## Auto-merge is slow to fire

- **Symptom**: the PR is green but sits open for a while.
- **Cause**: GitHub evaluates auto-merge asynchronously after the last check passes.
- **Fix**: wait. It does fire. If you're in a hurry, merge the PR by hand; bunker notices it is merged.

## `ci-timeout`

- **Symptom**: status `ci-timeout`; the PR is still open.
- **Cause**: not merged within `--ci-timeout` minutes (default 30). This only happens with `bunker issue`/`bunker queue --merge`; under `bunker watch` the shepherd waits for the merge and there is no `ci-timeout`. Checks are still running, failing, or waiting on a runner.
- **Fix**: look at the PR's checks. Auto-merge is still armed, so GitHub may merge it later. For slow CI raise `--ci-timeout`. The worktree is kept; remove it with `git worktree remove` once the PR is dealt with.

## `merge-failed: no required status check`

- **Symptom**: status `merge-failed`; the error says the default branch has no required status check in its rulesets.
- **Cause**: with no required check GitHub would merge the PR at once, so bunker refuses to arm auto-merge (#285). It reads **rulesets** and classic **branch protection**; the latter needs Administration: read on the token, and if it can't be read the error says so (it is not treated as "no check").
- **Fix**: add a ruleset on the default branch that requires a status check (Settings → Rules → Rulesets), then re-run. `bunker doctor` checks this.

## `verify-failed`

- **Symptom**: status `verify-failed`; nothing was pushed.
- **Cause**: `verify` still failed after the fix round (the implementer gets the output and tries again, `verify_retries` times, default 1).
- **Fix**: read the verify output in the run log. Raise `verify_retries`, fix the cause or the issue text, then re-run; the worktree and branch are kept.

## `idle-timeout`

- **Symptom**: status `idle-timeout`; the error says an agent, reviewer, setup or verify "produced no output" or "timed out".
- **Cause**: an agent or reviewer printed nothing for `--idle-timeout` minutes (default 10), or setup/verify ran longer than `--step-timeout` minutes (default 30). The process (for a container, the container itself) was killed.
- **Fix**: raise the limit if the step is legitimately slow; otherwise look at the run log to see where it hung. The worktree and branch are kept. Under `bunker watch` the issue is relabelled `bunker:failed`. An agent that finishes but doesn't exit is killed `--completion-timeout` seconds (default 60) after its final result event, and counts as done, with a warning.

## Issue relabelled `bunker:failed`

- **Symptom**: `bunker watch` removed `bunker:queued` from an issue, added `bunker:failed` and left a comment.
- **Cause**: the issue ended in anything other than `merged`. It is never retried automatically, so a broken issue can't burn budget in a loop.
- **Fix**: read the one-line reason in the comment (or run `bunker status` for every failure with its reason, link and retry command) and the run log, fix the cause (or the issue text), then re-add `bunker:queued` to retry.

## `node_modules` or `tsc` missing in a worktree

- **Symptom**: the agent or verify says `tsc: not found` or can't resolve modules.
- **Cause**: a worktree is a fresh checkout without installed dependencies.
- **Fix**: put the install in `setup` in `.bunker/config.toml`, e.g. `setup = "bun install"`. It runs before the agent and before verify. Commit it to the default branch.

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

## `paused-usage-limit`

- **Symptom**: status `paused-usage-limit`; `bunker issue` exits with code 3.
- **Cause**: `claude` hit your plan's usage limit mid-issue. This is not a failure: the worktree, branch and agent session are kept, and the issue keeps its `bunker:queued` label (it is never relabelled `bunker:failed`).
- **Fix**: nothing under `bunker watch`: it sleeps until the reset time (or `--interval` if none was given), then resumes the same session. Otherwise re-run `bunker issue N` after the printed reset time; it resumes the interrupted step.
- **Plain `bunker review` and `bunker "<prompt>"`**: these also exit with code 3 and print the reset time, but nothing resumes them. The worktree and agent session are discarded; `bunker review` keeps the branch with the work committed so far. Re-run the command after the reset time.
