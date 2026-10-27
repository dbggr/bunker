# Security policy

bunker runs AI agents against your code with access to tokens on your machine, so security reports are taken seriously.

## Reporting a vulnerability

Report it **privately** through GitHub's security advisories: [Report a vulnerability](https://github.com/dbggr/bunker/security/advisories/new). Don't open a public issue or PR for it.

Include what an attacker controls (for example an issue body, a comment, a file in a PR or a fork), what they gain (code execution on the host, a token, an unreviewed merge…), and the steps to reproduce. You'll get an acknowledgement within a few days, and a fix or mitigation plan once the report is confirmed. You'll be credited in the advisory unless you prefer not to be.

## Supported versions

bunker is pre-1.0: only the latest `vX.Y.Z` release and `main` receive security fixes.

## Scope

The threat model, including what bunker deliberately doesn't protect against (for example, `--no-sandbox` is not isolation, and the agent container has outbound network access), is in [docs/security.md](docs/security.md). Reports that bypass a gate described there are in scope; problems in Claude Code, Docker or GitHub themselves should go to those projects.
