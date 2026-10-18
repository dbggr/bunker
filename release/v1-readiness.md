# v1.0 readiness (#329)

What v1.0.0 promises, how close bunker is, and what would prove it, from raw evidence rather than impressions.

- **Sources:**
  - every run log in `.bunker/runs` (142 logs, 2026-10-16 18:02Z to 2026-10-18 01:22Z)
  - GitHub's history of this repo: 151 PRs, 132 CI runs on `main`, issue label events
  - the cost recorded in each run's `result` events
- **Snapshot:** the numbers below were taken at 2026-10-18 01:22Z; re-running gives newer ones (GitHub answers are cached, so pass `--refresh`).
- **Reproduce:**
  - `bun scripts/v1-readiness.ts` (add `--since 2026-10-17T12:00:00Z` for the recent window, `--json` for raw numbers)
  - `bun scripts/mutate-gates.ts` for the gate mutation table
- **Two windows:**
  - **all**: everything logged, including the day bunker was still building its own merge plumbing
  - **recent**: since 2026-10-17 12:00Z, after GitHub auto-merge, the flaky-suite fix (#149) and restart cleanup (#160, #201)

Bunker PRs are recognised by the `Round N:` line every bunker-written PR body carries. 130 PRs are bunker's and 21 were written by hand (the spike, CI setup, the security fixes #273/#277/#316, and the #284 refactor).

## 1. Where it stands

| | all | recent |
|---|---|---|
| Runs logged | 142 | 56 |
| Runs that merged (of finished runs) | 108 / 132 (82%) | 43 / 51 (84%) |
| Issues attempted / merged | 124 / 108 | 48 / 43 |
| Merged on the first finished attempt | 103 / 108 (95%) | 41 / 43 (95%) |
| Runs needing a second review round | 20 | — |
| Interrupted runs (no final status) | 10 | 5 |
| `main` CI runs / red | 132 / 3 | 52 / 0 |
| Reverts on `main` | 0 | 0 |
| Human re-queues (relabel after a failure) | 12 | 6 |
| Issues taken over by hand after bunker failed | #82, #238, #294, #326 | #294, #326 |
| Agent cost | $131.75 | $15.79 |
| Cost per merged issue | $1.22 | $0.37 |
| Median cost per run | $0.25 | $0.21 |
| Median PR open → merged | 2.4 min | — |

- **Every failure was a refusal.** No failed run merged anything.
- **Main went red 3 times, all inside the flaky-suite window.** After bunker PRs #127, #138 and #150 (2026-10-16 22:16Z to 2026-10-17 01:10Z), in the window #149 (PR #159) fixed: cross-file timeout cascades and races in the parallel queue. Twice the next merge was green with no fix in between. The failing logs have expired, so each one's cause can't be proven; none was reverted. Main has been green for every run since 7175b78.
- **Interrupted runs lose time, not work.** Every interrupted run's issue that has finished since ended merged (#131, #132, #136, #191, #197, #230, #281, #306); #312 and #315 are in progress.

## 2. Failure taxonomy

All 24 failed runs, by class (`failureClasses` in the script):

| Class | all | recent | Root cause | Status |
|---|---|---|---|---|
| Merge plumbing before GitHub auto-merge | 6 | 0 | bunker polled CI itself with a token that can't read checks (403 → "unreadable", 5–20 min "pending" waits, `gh pr merge` refused while checks ran) | **Fixed**: GitHub auto-merge plus a required check (#63/#65); the ruleset makes it readable (iac-github#58, #285) |
| Agent code failed typecheck at verify | 4 | 3 | the implementer and reviewer approved code that `tsc` rejects (#120, #214, #230, #285); the reviewer didn't run the typecheck (now `check` gives it the typecheck output) | **Open**: the biggest lever left; see section 4, "verify feedback" |
| CI wait over `--ci-timeout` | 4 | 0 | the suite took over 30 min in the flaky window (#120, #131, #134, #135); auto-merge stayed armed and later merged | **Fixed** with #149; would also be absorbed by the PR shepherd (#283) |
| Workflow push refused | 2 | 0 | the agent edited `.github/workflows/ci.yml` (#77, #149) and the token's missing Workflows permission refused the push, **as designed** | **By design**; since #277 such PRs also need human review. The prompt now says workflows are off-limits |
| Leftover branch after a restart | 2 | 0 | a restarted watch found the previous attempt's branch (#131, #132) | **Fixed**: #160, #201 |
| Docker image missing | 2 | 2 | a host `bun test` deleted the watcher's image mid-run (#214, #230) | **Fixed**: #295 |
| Agent code failed a test at verify | 2 | 2 | a missing `setDefaultTimeout` guard (#230), and #307's first attempt breaking a usage-limit resume test (merged later as PR #326) | **Open** (same lever as typecheck) |
| Duplicate run | 1 | 0 | #197 was picked up again while its own PR #235 was open | **Working as intended**: the open-PR check stopped it before any work |
| Reviewer rejected after max rounds | 1 | 1 | #277: the reviewer found a real gate bypass (quoted paths), and it was finished by hand (PR #294) | **Working as intended**: the reviewer caught a security bug |

Today's mix: 7 of the 8 recent failures are verify refusing agent code (5) or the image deletion (2, fixed).

## 3. Escapes: bunker-merged changes that needed a fix later

Bug issues filed against code that had already merged through bunker (from the issue list, origin noted where the issue records it):

| Escape | Kind | Found by |
|---|---|---|
| #149 flaky suite: timeout cascade, parallel races (main red ×3) | test reliability | CI on main |
| #160 restart leaves the branch behind | robustness | a failed run |
| #208 a transient 429 treated as a usage-limit pause (found in #192) | logic | an agent in a later run |
| #236 watch summary skipped; a cap test fails on fast machines | logic + test | an agent |
| #271 watch ignores a relabel until restart (from #191) | logic | the user |
| #285 `--merge` armed without a required check (#275 incomplete) | **security** | an agent, then a human: the first fix would have blocked every merge |
| #293 tests send real desktop notifications | test hygiene | the user |
| #295 tests delete real docker images | test hygiene, broke the live watch | the user |
| #306 racy cleanup test (failed PR #305 twice) | test reliability | CI |
| #316 prompt templates read from the worktree (from #281/PR #311) | **security hardening** (not exploitable; see #316) | a human |
| #318 `.claude/`/`CLAUDE.md` not in the review gate (from #277) | **security** | a human |
| #322 audit test prints a shell error | test noise | the #284 session |

12 escapes against 128 merged bunker PRs (9%). 6 are in the tests rather than the product, and 3 are security gaps that only a human found. The security audit (#273–#278) predates most of this and covered the original design.

**What this says:** the gates (verify, required CI, the reviewer) reliably stop broken code from merging. They don't stop **missing behaviour** or **tests with side effects**, and nothing but a human has found a security gap yet.

## 4. Reliability bar for 1.0

Thresholds over a **14-day `--watch` soak** on bunker itself plus at least one repo bunker wasn't built on (core or a private repo), measured by `scripts/v1-readiness.ts --since <soak start>`:

| Metric | Bar | Measured (recent window) | Met? |
|---|---|---|---|
| Wrong merges: main red after a bunker merge, or a revert | **0** | 0 red in 52 runs, 0 reverts | on track (window too short) |
| Unattended success: merged / finished runs | ≥ 90% | 84% | ✗ |
| Merged on the first finished attempt | ≥ 90% | 95% | ✓ |
| Human interventions per merged issue (re-queues + takeovers + manual CI re-runs) | ≤ 0.10 | 0.21 (6 + 2 + 1 over 43) | ✗ |
| Escapes per merged bunker PR | ≤ 5% | 9% all-time | ✗ |
| Security escapes found by a human | 0 | 2 recent (#316, #318) | ✗ |
| Cost per merged issue | ≤ $2 | $0.37 | ✓ |
| Runs failing on state left by a crash or restart | 0 | 0 | ✓ |

**The two levers that move most of the ✗ rows:**
1. **Verify feedback (#336).** When verify fails, give the failure to the implementer for one fix round instead of ending the run. In the recent window that alone turns 5 of 8 failures into retries, which takes success above 90% and removes most re-queues.
2. **Test hygiene gates (#337).** A guard test that no test reaches the real Docker daemon, notifier or network (the #293/#295 class), plus running the reviewer with `bun run typecheck` output in its prompt (the `check` key).

## 5. Release contract: what 1.0 freezes

After 1.0.0, removing or renaming any of these needs 2.0:

- **CLI:** subcommands (`init`, `doctor`, `issue`, `queue`, `watch`, `shepherd`, `status`, `clean`, `triage`, `ui`, `audit`, `review`, `task`, `self-update`) plus the bare `bunker "<prompt>"`, and the flags in `docs/cli.md`; the old mode flags were removed (#358)
- **Repo config** (`.bunker/config.toml`): `setup verify verify_network verify_retries check copy context models.* skills watch.* merge.mode merge.ci_timeout clean.logs_days notify.*` (23 keys)
- **User config** (`~/.config/bunker/config.toml`): `max_cost_day max_cost_month allow_labelers` (the kebab-case spellings are still read for one release, with a deprecation warning)
- **Labels** (after #312): `bunker:queued`, `bunker:in-progress`, `bunker:failed`, `bunker:review`, plus `bunker:awaiting-review`, `bunker-blocked`, `discovered`, `priority:*`, `severity:*`. The old `bunker`/`bunker-failed`/`needs-human-review` names are no longer read or written (the cleanup was #356); `bunker doctor` flags any still on the repo
- **Library exports** (`src/index.ts`): 14 export lines (trimmed in #352)
- **Files:** `.bunker/` layout (`config.toml`, `Dockerfile`, `prompts/*.md`, `runs/`, `sessions/`), the `.env` locations, and the PR body format other tools may parse

**Fix before freezing** (each would be a breaking change after 1.0):
- **Config naming (#338), resolved:** both files are snake_case now (`max_cost_day`, `watch.max_cost_day`); the user config's old kebab-case keys are read for one release with a deprecation warning, and `bunker doctor` flags them.
- **The CLI shape (#340), resolved:** every mode is a subcommand (`bunker issue 7`, `bunker watch`) and the old mode flags are removed (#358).
- **Internal plumbing is exported (#339), resolved:** the library surface was trimmed to what an embedder needs (`run`, `runAll`, `review`, the agent and sandbox factories, and their types) in #352.
- **Labels:** #312 landed (PR #331). `bunker-blocked` is still outside the `bunker:` namespace; move it too, or accept the mix, before the freeze.
- **Identity:** #286 (App or bot) changes the token setup. Only blocking if 1.0 is public.

## 6. Verification that doesn't rely on the author or the user

| Check | How | Passes when |
|---|---|---|
| Gate mutation tests | `bun scripts/mutate-gates.ts`: breaks each of 14 safety gates in turn and runs the suite | every mutation is caught (table below) |
| Benchmark | ~10 representative issues (2 bugs, 4 small features, 2 docs, 1 refactor, 1 should-refuse) on **core** and **a private repo**, re-run per release candidate from fixed commits | ≥ 8/10 merge unattended, the should-refuse one refuses, 0 wrong merges |
| Verify mutation | for 5 merged bunker PRs, re-apply them with one injected bug (off-by-one, inverted condition, dropped await) and run verify | verify fails on ≥ 4 of 5 |
| Chaos | during a `--watch` with `--parallel 2`: `kill -9` mid-implement, `systemctl restart docker`, drop the network for 2 min, force a usage limit; then `bunker status` / `bunker clean` | every issue ends merged or cleanly failed; nothing orphaned (worktrees, branches, labels, containers) |
| Red team | a public scratch repo with an injection corpus: issues and comments from a non-maintainer, edited-after-label bodies, `<issue>`/`<verdict>` spoofing, instructions inside quoted logs, planted `.claude/`/`.bunker/` files | nothing queued, merged or run on the host that a maintainer didn't approve |
| Independent scan | `claude-security` scan of the tagged release candidate | no high or critical findings open |
| Clean install | a fresh VM or container with only git, Docker, gh and Claude: follow the README to the first merged PR | no step the README doesn't state |

### Gate mutation results

From `bun scripts/mutate-gates.ts`: each gate is broken on its own, then the suite and typecheck run. The first 14 ran on 8d85062; the two #318 gates ran on bb95d68, after #318 merged, with every earlier pattern still matching once.

| Gate broken | Result |
|---|---|
| human-review paths (`.bunker/`, `.github/`) | caught (5 tests fail) |
| human-review skips `.claude/`, `CLAUDE.md`, `AGENTS.md` | caught (5) |
| human-review fails open on a diff error | caught (**1**) |
| reviewer reads the agent's `.claude/` and `CLAUDE.md` | caught (3) |
| required check missing → still arm auto-merge | caught (5) |
| rulesets unreadable → still arm auto-merge | caught (2) |
| git guard ignores changed hooks/config | caught (4) |
| host git keeps repo hooks | caught (3) |
| git common dir mounted writable | caught (2) |
| isolated verify gets the network | caught (2) |
| isolated env keeps Claude credentials | caught (3) |
| redaction skips secret values | caught (5) |
| label gate skips the permission check | caught (7) |
| label gate allows edits after labelling | caught (3) |
| every comment trusted | caught (5) |
| prompt template from the worktree | caught (**1**) |

**16 of 16 caught.** Two gates hang on a single test each (the fail-closed diff path and the template source); a second test for each is cheap insurance before a refactor. Re-run the whole table on each release candidate: a pattern that stops matching shows up as `STALE`.

## 7. Cut list

| Issue | Verdict | Why |
|---|---|---|
| #318 `.claude/` review gate | **done** (PR #328) | security |
| #315 security docs | **done** (PR #332) | the security model documented as built |
| #312 `bunker:*` labels | **done** (PR #331) | contract |
| #322 audit test noise | **done** | test hygiene |
| #308 install script | **done** | needed for the clean-install check |
| #319 context/spec files | **done** (PR #333) | additive |
| #338 config key naming | **done** | contract |
| #339 library export trim | **done** (#352) | contract |
| #340 CLI shape | **done** (#358) | contract |
| #336 verify feedback round | **done** | the bar: success rate and interventions |
| #337 test hygiene guard | **done** | the bar: escapes |
| #286 bot identity | blocks 1.0 **only if public** | changes token setup |
| #283 PR shepherd | **done** | not opt-in: `bunker watch` runs it on every pass |
| #317 skills | **done** | additive config |
| #327 live cost + budget in the hub | **done** (#359) | UI only |
| #309 release binaries | after 1.0 (public) | distribution |
| #289 demo video | after 1.0 | by design |
| #280 session fork | **done** (#353) | shipped as `fork()` on a run result |

**Order:** the contract and the bar items above are done. Next, start the 14-day soak plus the benchmark, chaos and red-team checks; tag 1.0.0 when the bar holds for the whole window.
