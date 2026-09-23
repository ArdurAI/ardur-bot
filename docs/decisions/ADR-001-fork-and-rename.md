# ADR-001: Fork Rakazo, rename fully, track upstream with a script

Status: accepted (2026-09-23)

## Context

Ardur Bot is an installable desktop app where each bot is pinned to a configured
provider, model and effort level, running on the user's own subscriptions and
keys, with bots on the host machine, Docker, Podman or Kubernetes. Rakazo
(https://github.com/elie222/rakazo, Apache-2.0) already has per-bot
`modelProvider` / `modelId` / `thinkingLevel`, group chats, routines, approvals,
MCP connectors, Docker/E2B/Daytona/Box computers, and Electron + Expo apps.
Upstream lands roughly 700 commits a month, so it will keep adding things we want.

## Decision

1. Fork Rakazo with full git history so `git merge upstream/main` works.
2. Rename every identifier now (package scope `@ardurbot/*`, env prefix
   `ARDURBOT_*`, app ids `ai.ardur.bot`, image names, users, headers, CSS
   classes). Lowercase `rakazo` becomes the bare word `ardurbot` because it
   appears in Unix usernames, Postgres identifiers, JS identifiers, HTTP headers
   and a URL scheme, where a hyphen would break.
3. Keep the rename in `scripts/rename-from-upstream.py`, idempotent and ordered
   specific-before-generic. Merging upstream is: merge, run the script, review
   the diff, commit.
4. Branch policy: all work lands on `dev`. `main` only moves from `dev` after a
   human has tested and verified the build. CI is advisory, not a merge gate.

## Consequences

- Upstream merges touch many files; the script makes that mechanical, but
  conflicts in files we also changed still need hands.
- Deliberate divergences from upstream (for example the Claude subscription
  path, see ADR-002 when written) live in new files where possible.
- `NOTICE` and `docs/decisions/` keep the upstream name on purpose and are
  excluded from the script.
