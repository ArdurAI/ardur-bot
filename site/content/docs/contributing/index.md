---
title: "Contributing to Ardur"
description: "Thanks for helping. Ardur is early and moves fast, so the process is deliberately light."
source_path: "CONTRIBUTING.md"
---

> [Source: CONTRIBUTING.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/CONTRIBUTING.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Thanks for helping. Ardur is early and moves fast, so the process is deliberately light.

## How work flows

- All work lands on the `dev` branch. Open a pull request against `dev`, or push to `dev`
  directly if you are a maintainer.
- `main` only moves from `dev` after a human has tested and verified the build.
- CI (lint, typecheck, build, unit tests) is advisory. A red check is a hint, not a gate.
  Please look at it, but a maintainer can merge with it red when the failure is unrelated.
- Small, focused changes are easier to review.

## Run locally

Follow the [source checkout setup](/docs/readme/#run-from-source) for prerequisites, secrets and
startup commands.

## Useful checks

| Command | What it covers |
| --- | --- |
| `pnpm check` | TypeScript across the monorepo |
| `pnpm lint` | Biome lint and format |
| `pnpm test` | Offline unit tests: scripted runtime, fake sandbox, in-memory jobs. No keys. |
| `pnpm test:integration` | Postgres via Testcontainers: product journeys, authorization, executor lifecycle. Needs Docker. |
| `pnpm test:e2e` | Playwright against the emulated API. Needs Docker. |
| `pnpm test:pi` | The real Pi runtime against a local model fixture. No keys. |

Run `pnpm check` and `pnpm test` before opening a PR when you can. The rest are there when
you touch that area.

When running web E2E locally (`pnpm --filter @ardurbot/web e2e`), Playwright starts its own web server and fails fast if the web port is already in use, preventing test signups (`@example.test`) from polluting a running developer database. To opt in to reusing a running dev server, set `PLAYWRIGHT_REUSE_SERVER=1`.

## Changes from upstream

Ardur does not sync with its upstream project automatically. To bring in an upstream change,
port it on a branch like any other change: use Ardur's names for anything it adds, keep the
stable internal identifiers (app and bundle ids, database names, storage keys, protocol names,
the `ARDURBOT_*` variables and the `@ardurbot/*` package scope), and review the diff before it
lands. The upstream name appears only in `LICENSE`, `NOTICE` and the dated fork entry in
`CHANGELOG.md`; `scripts/no-upstream-references.test.ts` fails if it appears anywhere else. See
`docs/decisions/ADR-001-fork-and-rename.md`.

## Public repository

Never commit secrets, `.env` files, private URLs, or personal data. Use placeholders.
