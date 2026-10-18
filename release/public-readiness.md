# Public readiness (#374)

Evidence for the checks that have to pass before the repository goes public. #374 holds the checklist; this file records the results.

## Secret scan of the full history

- **Date:** 2026-10-19
- **Tool:** gitleaks 8.16.0 (Ubuntu package `8.16.0-1ubuntu0.24.04.3`), default rules
- **Command:** `gitleaks detect --source . --log-opts="--all" --redact --report-format json --report-path gitleaks.json`
- **Scope:** every ref (`--all`), 252 commits scanned, up to `c487da8` on `main`
- **Result:** 2 findings, both false positives. No real secret is in the history.

| Rule | Location | Commits | Verdict |
|---|---|---|---|
| `private-key` | `test/init.test.ts:166` | `0832070c`, `a2a165d8` | False positive: a dummy PEM whose body is the literal text `secretkeybody`, written to a temp file by the `bunker init` App-identity test (#389). It was never a real key. |

Re-run before the visibility flip if anything lands on `main` in between; the same command with `--log-opts="<last scanned sha>..origin/main"` covers only the new commits.
