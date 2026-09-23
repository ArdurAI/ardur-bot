# Contributing to Ardur Bot

Thanks for helping. Ardur Bot is early and moves fast, so the process is deliberately light.

## How work flows

- All work lands on the `dev` branch. Open a pull request against `dev`, or push to `dev`
  directly if you are a maintainer.
- `main` only moves from `dev` after a human has tested and verified the build.
- CI (lint, typecheck, build, unit tests) is advisory. A red check is a hint, not a gate.
  Please look at it, but a maintainer can merge with it red when the failure is unrelated.
- Small, focused changes are easier to review and easier to keep in sync with upstream Rakazo.

## Run locally

Follow the [source checkout setup](README.md#run-from-source) for prerequisites, secrets and
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

## Syncing with upstream

Ardur Bot is a fork of [Rakazo](https://github.com/elie222/rakazo). To pull upstream changes:

```sh
git fetch upstream
git merge upstream/main
python3 scripts/rename-from-upstream.py
# review the diff, then commit
```

See `docs/decisions/ADR-001-fork-and-rename.md`.

## Public repository

Never commit secrets, `.env` files, private URLs, or personal data. Use placeholders.
