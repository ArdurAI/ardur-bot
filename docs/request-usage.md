# Request usage ledger

The ledger supports the builder and team lead who need trustworthy spend by run and root task.
`recordRunUsage` retains its totals-only call shape and accepts an optional `AgentUsage.request`.
The request types are exposed by `packages/adapter-kit/src/types.ts`; the shared strict wire schema
is in `packages/contracts/src/request-usage.ts`, and ledger validation lives in
`packages/adapters/src/request-usage.ts`. Runtime collectors supply normalized facts. The ledger
does not select models, authorize tools, parse provider responses, or estimate subscription prices.

## Identity and replay

A request is scoped by space, user, persisted run, optional delegation, `requestId`, `attemptId`,
and counter `epochId`. The ledger hashes that tuple into the unique `UsageRecord.requestKey`.
Identifiers must be opaque, stable across delivery retries, and free of prompts or credentials.
A real provider retry gets a different attempt ID and remains billed. A helper uses its admitted
delegation ID so parallel helpers cannot collide inside their parent run.

Each observation has a nonnegative integer `sequence`, unique within that request/attempt/epoch.
The unique receipt in `request_usage_observations` stores the validated observation and its
fingerprint. Replaying the same sequence and payload is a no-op, including after a later update.
Reusing a sequence with different data fails. Provider, model, purpose, parent request, counter
mode, root task, and input/reasoning semantics cannot change within the same request attempt.

The ledger validates the persisted run's scope and the delegation relationship, then uses the
same root-task row lock as delegation admission/settlement. A run lock serializes cancellation.
Receipt insertion, normalized totals, root/delegation budget increments, remaining live
reservation release, and the durable `usage.recorded` event commit together. Transaction
conflicts use the existing bounded `withTransactionRetry` policy. Realtime notification happens
after commit; cursor polling recovers the durable event if notification fails. A retry after
that failure cannot bill again.

Cancelled requests still incurred spend. Their ledger records and receipts persist, while the
existing history fence prevents new thread events. No approval, effect, grant, revision, or
redaction boundary is relaxed to collect usage.

## Counters and totals

- `delta` observations add newly reported usage once; sequence delivery may be out of order.
- `cumulative` observations report totals from zero within this request/attempt/epoch. A later
  sequence replaces known cumulative counters and charges only the increase. An unseen older
  sequence or any decreasing known category fails. A verified reset needs a new epoch covering
  only new spend. Session-wide counters must be normalized by the runtime collector before use.
- A correction uses a higher sequence. Same-sequence edits and downward corrections are rejected
  rather than guessed. Do not invent a new epoch merely to bypass a conflicting observation.
- Missing category values are `null`; measured zero is `0`. Incomplete deltas retain known lower
  bounds and partial coverage. A later complete cumulative snapshot can close those gaps.
  Receipts preserve the original supplied values, including nulls.

The six category names match schema 3's `USAGE_CATEGORIES` and `RequestUsageEvidence` in
`packages/testkit/src/performance-report.ts`:

| Contract category | UsageRecord column | Meaning |
| --- | --- | --- |
| `logicalInput` | `logicalInputTokens` | Input total, including cache components once |
| `uncachedInput` | `uncachedInputTokens` | Uncached component |
| `cacheReadInput` | `cacheReadInputTokens` | Cache-read component |
| `cacheWriteInput` | `cacheWriteInputTokens` | Cache-write component |
| `output` | `reportedOutputTokens` | Normalized output before adding separate reasoning |
| `reasoning` | `reasoningTokens` | Reported reasoning, with explicit subset/separate semantics |

When all input categories are supplied, uncached + read + write must equal logical input.
Partial known components may not exceed a known total. The normalized components are disjoint
under both input semantics; the semantics describe the provider's original input field.
Reasoning is either a subset of output or separate. Unknown input semantics cannot claim cache components; unknown reasoning semantics cannot
claim a reasoning value. Negative, fractional, nonfinite, or overflowing counts fail.

The compatibility `inputTokens` column stores known logical input. `outputTokens` stores known
output plus reasoning only when reasoning is separate. Existing sum queries therefore continue
to count each token once. Unknown categories contribute no *known* tokens to those nonnullable
columns, but nullable category columns and `categoryCoverage` distinguish that lower bound from
measured zero. Readers needing completeness must inspect coverage. `coverage: complete` describes
token categories only; it says nothing about price, task acceptance, or missing whole requests.

With `request` present, its categories are authoritative. The outer `AgentUsage.inputTokens` and
`outputTokens` must equal this observation's known totals using the same reasoning rule; they
are checked before writing. Without `request`, the legacy adapter preserves each call's totals,
marks it `purpose: legacy` / `coverage: partial`, and leaves request identities, categories and
prices unknown. It cannot safely deduplicate callers that supply no observation identity.
Historical rows are not reinterpreted or retroactively deduplicated.

## Attribution, cost, and retention

The ledger derives `rootTaskId`, requester/acting bot, depth and delegation from persisted state.
It snapshots the admitted run or helper pin while retaining the usage's observed provider/model.
This is attribution, not pin attestation. The runtime remains responsible for honoring the pin.
Pins are not reconstructed from mutable bot settings.

Purposes are `main`, `retry`, `helper`, `summary`, `delegated`, and `detached-learning`.
Detached learning retains its root attribution and spend but never increments synchronous task
budgets. Delegation admission also excludes it when seeding an initially absent root budget.
Accepted-task reporting must join actual task acceptance and select synchronous purposes; a
completed run or a ledger row is not evidence of acceptance.

`cost` is nullable USD. Known cost, including zero, requires a source, date, and provider-reported
or rate-card provenance. No rate is inferred from tokens. Delta cost totals remain null when any
delta is unpriced; a cumulative reported price can supply a complete total. Individual pricing
provenance lives in immutable receipts; a priced aggregate points to those receipts through
`pricingProvenance.kind: request-observations`. Existing event cost fields remain null: receipt
and ledger queries are the price source. Subscription quota/allocation and review minutes remain
separate measurements.

The additive `20260925000100_request_usage` migration uses mapped table names and preserves old
rows and sums. Run deletion still sets `runId` null without deleting spend; bot/root attribution
and the pin snapshot remain. Space deletion removes the usage records and cascades to receipts.
No prompt, tool result, raw provider response, credential value, or transcript is accepted in the
observation shape. Callers remain responsible for safe identifiers and price-source labels.

## Runtime collection and coverage

`RequestUsageCollector` in `packages/adapter-kit/src/usage-collection.ts` produces a started receipt,
cumulative numeric observations, and a terminal receipt for each observable attempt. A terminal
receipt retains the same counters; it does not charge them again. Optional `collection` metadata
records a mapping version, scope, outcome, availability, whitelisted raw numeric categories, and
explicit limitations. It carries no provider payload or prompt. Unpriced collection always leaves
cost and pricing provenance null. A process killed before receipt delivery can still leave an
unsettled started receipt; recovery of that uncertainty requires separate crash acceptance.

`observePiUsage` in `packages/adapters/src/pi-request-usage.ts` observes HTTP responses consumed by
the installed Pi SDK through its fetch hook. It preserves retry, transport and timeout options.
Each HTTP retry gets its own attempt ID under the logical request; helpers retain their admitted
delegation and the parent request ID. A bounded pass-through reads usage fields from HTTP JSON/SSE
without retaining payloads. Oversized or unavailable transport detail remains explicit. Other
transports retain a runtime-call receipt and only positive SDK-normalized lower bounds: the SDK's
initialized zeros cannot establish measured zero. Request-level coverage on those routes is unknown.

Anthropic's uncached input, cache reads and cache creation are additive. OpenAI input includes cache
subsets; reported reasoning is a subset of output. Missing fields remain null, including omitted
cache-write or reasoning counts. `normalizeUsageCounts` rejects negative, fractional, nonfinite,
overflowing and contradictory counters. These mappings follow the documented
[Anthropic categories](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and
[OpenAI caching fields](https://developers.openai.com/api/docs/guides/prompt-caching).

`ClaudeStreamParser` records attested `modelUsage` even on an error result and ignores repeated
results. Its scope is a native turn: internal retries, helpers and native compaction are not
individually exposed. `CodexUsageCollector` also has native-turn scope. A fresh thread starts at a
zero boundary; a resumed thread needs a matching usage notification observed before `turn/start`.
Without it, the collector records unavailable usage instead of charging lifetime totals. It
subtracts the verified boundary, ignores duplicates and other turns, and freezes at the known
lower bound after a decreasing counter. Such totals have partial coverage. The documented
[Codex notification contract](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts)
identifies the thread and turn, while its
[counter structure](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/TokenUsageBreakdown.ts)
describes the supplied categories. Replay tests verify this mapping; installed native versions
still require acceptance.

After Codex reports completion, a `thread/read` response bounds draining of already delivered
final usage. The collector does not claim that future notifications cannot arrive after this
boundary. A failed boundary check is explicit. Real CLI ordering remains a live acceptance item.

`accountRuntimeUsage` in `packages/adapters/src/runtime-usage.ts` persists usage before executor
consumer fences can discard it. Cancellation drains queued accounting after tool work has been
aborted, without releasing further text or tool events. Failure or cancellation without totals
produces an unavailable receipt, not measured zero. Existing totals-only runtimes receive a
runtime-call identity with limited coverage. Scripted and command-replay execution retain their
existing path.

Background handlers connect Ardur summaries and detached reviews to `recordRunUsage`. New
`history.compact` jobs carry `sourceRunId`; older queued jobs select the latest run within the same
thread, bot, space and user before spending. Without a scoped source, compaction leaves history
intact. Summary spend survives a failed summary or a rejected generation update. Reviews keep the
same model, reservations, prompts and tool prohibition. Detached review usage is excluded from
`loadLearningRecords` so its own metering cannot invalidate the reviewed source watermark.

Category completeness, request attribution and live-route coverage are different denominators.
A complete turn aggregate cannot prove that every internal native request was observed. The live
attribution target is at least 99%; replay results do not establish that target. No client UI or
translation catalog is changed by these collectors, and no new database migration is needed:
collection metadata uses W0-2's immutable JSON receipt column.

## Runtime and trace handoff

W0-3 must populate `AgentRuntimeEvent.request` and `recordHelperUsage`'s
`AgentUsage.request` for normal/resumed turns, retries, helpers, summaries, delegated work and
detached learning. The executor forwards request observations intact. `recordRunUsage` returns
only newly persisted primary-call input/cache deltas for the Chief of Staff run metrics; exact
replays return null and cumulative corrections return only their increase. Summary, helper and
detached-learning spend does not inflate primary-turn context metrics. A delegated run retains
its own primary-call measurements. Legacy production behavior remains runnable until provider
collectors land. Do not send both a legacy and request-level observation for the same spend.

Brief maintenance records through the same ledger with purpose `summary`. Each actual model
invocation has a distinct identity. Supplied request observations retain their counters and
categories under an invocation namespace; legacy totals receive delta sequences with unknown
cache/reasoning detail and null prices. Delivery replay of an identified observation deduplicates;
a fresh maintenance invocation remains billed. Legacy runtime events without identity cannot
distinguish duplicate delivery from a second observation. Context snapshots are best-effort
diagnostics, saved after ledger persistence: an interrupted snapshot write can omit a measurement,
but retrying the observation cannot increment metrics or budgets twice.

The trace collector uses durable receipts for observation identity and the request row for its
latest normalized totals. Export one request-delta total per request/attempt/epoch, or explicitly
derive nonoverlapping deltas; never sum cumulative snapshots. Use schema 3's `request-delta` or
`cumulative-difference` provenance, bind the actual request/usage hashes, and namespace IDs across
runs and epochs. Provider/source hashes, trace clocks, outcomes, failed requests without usage,
and missing-reason detail must come from collectors; the ledger cannot fabricate them.
`usage-ledger-contract.test.ts` checks the shared category, purpose and semantic vocabulary
without making product adapters depend on testkit.

Verification includes deterministic normalization tests, the existing usage/delegation suites,
and `run-usage.postgres.test.ts`. The PostgreSQL suite runs only when
`USAGE_LEDGER_TEST_DATABASE_URL` selects a disposable loopback database named `usage_ledger_test*`.
An omitted database skips that suite and is incomplete PostgreSQL verification, not a pass.
