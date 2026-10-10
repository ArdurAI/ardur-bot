---
title: "Failure categories"
description: "One typed table — `packages/contracts/src/failure-categories.ts` — names every cause a run"
source_path: "docs/failure-categories.md"
---

> [Source: docs/failure-categories.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/failure-categories.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

One typed table — `packages/contracts/src/failure-categories.ts` — names every cause a run
or a handoff can end with. The server stores the category id plus its parameters (bot,
runtime, member). Codex failures also retain bounded, redacted process and protocol
diagnostics in `runtimeProblem.failure`, separate from the sentence shown in chat. Each
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
| `runtime-stopped` | the app-server process or transport stopped | retry |
| `runtime-turn-failed` | the app-server rejected or could not finish the turn | retry |
| `model-context-too-small` | the pinned runtime needs a model with at least 64K context | open the model pin settings |
| `session-start-failed` | the runtime did not complete its session handshake | retry after checking the runtime |
| `runtime-tool-catalog-mismatch` | the tool list differs from the confirmed startup list | retry after checking the cause |
| `runtime-profile-unacknowledged` | the runtime did not confirm its effective settings | retry after checking the cause |
| `provider-request-too-large` | the model request exceeded a byte limit | retry after checking the cause |
| `provider-response-too-large` | the model response exceeded a byte limit | retry after checking the cause |
| `provider-grant-refused` | the model request was outside the run grant or its grant expired | retry after checking the cause |
| `provider-auth-failed` | the provider returned HTTP 401 or 403 | open the model pin settings |
| `provider-request-failed` | the provider failed with an HTTP error other than 401, 403 or 429, or an unknown safe reason | retry after checking the cause |
| `other` | any failure the signals above do not name | none |

A category's entry also carries the sentences for the group-model and handoff contexts
when those apply, and the sentences older builds stored verbatim. Readers map stored
English text back to its id with `failureCategoryFromText`; anything unknown shows the
consumer's generic line, never a wrong category.

Codex starts an app-server process for each runtime invocation, normally one run, and
uses stdio JSON-RPC for startup and the tool/model loop inside its turn. It does not
restart the process between model steps. Requests have a 15-second deadline; EOF,
process failure and malformed protocol output end the stream. The process is closed
when the invocation finishes or is interrupted. A notification with `willRetry: true`
leaves retry ownership with Codex.

After saved progress, a lost transport retries on a fresh process after 20, 40 and 60
seconds. Recovery uses the planned-restart checkpoint and tool receipts on the same
pin. Completed results are reused once per recovery; uncertain effects require review.
Sign-in, usage-limit, model and protocol refusals are not automatic transport retries.
Cancellation interrupts the backoff. Controlled comparisons keep their frozen input
and do not use this recovery path.

Failure details name the step (`spawn`, `handshake`, `turn-start` or `stream`), error
class and redacted message, plus exit code, signal, protocol code and redacted stderr
when available. Failed events and worker/process failure logs retain these details;
normal chat renders only the category sentence. General detailed child output still
requires its existing opt-in. A queue job can report success after it durably records
a failed run: queue success means the handler finished, not that the run succeeded.

## Settings checks

`canBotRun` in the adapter package is used both by runtime selection and by
`models.validatePin`. The editor, bot save and group override save reuse the same
placement, connection, locality and context predicates. Duplicates recheck the copied
pin inside the creation transaction against the final bot and computer, so legacy
impossible settings are not copied into a fresh bot. Settings failures reuse
this table's sentences rather than introducing separate editor wording. An
unknown transport error stays generic and leaves Save disabled.

Bot and space destination-policy saves check the affected bots' saved or inherited
model endpoints through the same locality predicate, without live model probes.
Space refusals identify the bots whose models need changing. Policy edits check only
the destination rule being changed, so relaxing a policy does not revalidate unrelated
legacy runtime settings. Unchanged Ollama pins are checked without contacting their
server. Changed Ollama pins retain discovery checks; an unavailable server gives a
retryable precondition sentence, not an invalid-settings refusal.

## Adding a category

1. Add one entry to `FAILURE_CATEGORIES` (id, default English sentence, action, optional
   group-model and handoff sentences, legacy sentences).
2. Add the matching message in `apps/web/src/lib/failure-category-copy.ts` — the
   completeness test fails until the table, the web message, the mobile catalog entries
   and this page all name the new id.
3. Extract and fill the web catalogs (`pnpm --filter @ardurbot/web intl:extract`, then a
   non-empty `msgstr` in all nine) and add the ru and zh mobile catalog entries.
4. Add the row above.
