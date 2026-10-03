# Command error translation: known limitation

Date: 2026-10-03
Status: deferred; tracked in [#140](https://github.com/ArdurAI/ardur-bot/issues/140).

## Decision and reason

PR #131 does not wire translation of backend refusal sentences. The command-size
and file-location sentences have entries in all nine web catalogs, but the
conversation renders raw backend error text. Non-English users still see English.
This limitation is documented rather than adding display-boundary changes to a
security-fix review.

This affects operators and builders reading failed command or file operations.
There is no visible behavior change in this documentation commit. Existing
approvals, runtime pins and platform boundaries stay unchanged.

## Source path

- `packages/adapters/src/command-recording.ts:395`: command-size refusal.
- `packages/host-runtime/src/host-policy.ts:6`: file-location refusal.
- `apps/web/src/components/ThreadCommandBlock.tsx:47-53`: forwards the recorded
  block without an error translation lookup.
- `apps/web/src/components/ThreadCommandBlock.tsx:119-120`: renders search
  results through `commandOutput`.
- `packages/ui-web/src/command-block.tsx:106`: renders `commandOutput(block)`.
- `packages/core/src/command-blocks.ts:430-431`: inserts `block.error` as raw text.
- `apps/web/src/locales/command-tools-catalog.test.ts:6-22`: checks catalog
  presence, not conversation lookup.

## Follow-up boundary

Prefer stable shared error identifiers and translate only supported refusals at
the display boundary. Do not translate arbitrary command output or rewrite
retained evidence. Cover expanded blocks and search results with non-English
rendering tests that fail when lookup is removed. Cover web/Electron and
applicable mobile paths, or document a safe limitation.

The alternative was to wire lookup in PR #131. It was deferred to keep security
changes independently reviewable. Catalog-only tests are not proof of translated
conversation rendering. No new service, dependency or recurring cost is needed
for this documentation; the future implementation needs its own review.
