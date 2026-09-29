# Changelog

## Unreleased

- Forked from Rakazo commit `59d4f0c2` (2026-09-23) under Apache-2.0. See `NOTICE`.
- Project-wide rename to Ardur (`scripts/rename-from-upstream.py`).
- Trimmed CI to advisory lint, typecheck, build and unit tests.
- Added `NOTICE`, issue templates, and the ADR log under `docs/decisions/`.
- Retired `scripts/rename-from-upstream.py` (kept in the Git history). A unit test now fails if
  the upstream name appears outside `LICENSE`, `NOTICE` and the fork entry above.
