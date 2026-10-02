# Failure categories

One typed table — `packages/contracts/src/failure-categories.ts` — names every cause a run
or a handoff can end with. The server stores the category id plus its parameters (bot,
runtime, member); the worker stores only the category, never the provider's raw text. Each
app translates the category's sentence through its own catalogs: web through Lingui
(`apps/web/src/lib/failure-category-copy.ts`, whose test pins every message to the table),
mobile through its own catalogs (English source plus ru and zh).

## The categories

| id | meaning | action offered |
| --- | --- | --- |
| `usage-limit` | the runtime's usage limit is reached; it resets on its own | retry |
| `signed-out` | the runtime's sign-in expired or is missing | connect |
| `max-turns` | the run reached its turn limit | retry with a narrower task |
| `model-unavailable` | the pinned model no longer exists or is not offered | open the model pin settings |
| `configuration-invalid` | the pin or runtime configuration is invalid | open the model pin settings |
| `connection-missing` | the model connection is missing | connect |
| `experimental-off` | the runtime is experimental and the bot has Experimental off | turn on Experimental (or open the model pin settings) |
| `computer-unsupported` | the runtime runs on the host computer, not in the bot's sandbox | open the bot's computer settings (or the model pin settings) |
| `destinations-bot` | the bot's allowed model destinations block the model | open the bot's destinations settings (or the model pin settings) |
| `destinations-space` | the space's model policy blocks the model | open Settings at Models (or the model pin settings) |
| `stopped` | the run or worker was stopped before finishing | none |
| `model-context-too-small` | the pinned runtime needs a model with at least 64K context | open the model pin settings |
| `session-start-failed` | the runtime did not complete its session handshake | retry after checking the runtime |
| `other` | any failure the signals above do not name | none |

A category's entry also carries the sentences for the group-model and handoff contexts
when those apply, and the sentences older builds stored verbatim. Readers map stored
English text back to its id with `failureCategoryFromText`; anything unknown shows the
consumer's generic line, never a wrong category.

## Adding a category

1. Add one entry to `FAILURE_CATEGORIES` (id, default English sentence, action, optional
   group-model and handoff sentences, legacy sentences).
2. Add the matching message in `apps/web/src/lib/failure-category-copy.ts` — the
   completeness test fails until the table, the web message, the mobile catalog entries
   and this page all name the new id.
3. Extract and fill the web catalogs (`pnpm --filter @ardurbot/web intl:extract`, then a
   non-empty `msgstr` in all nine) and add the ru and zh mobile catalog entries.
4. Add the row above.
