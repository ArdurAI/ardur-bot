---
title: "Production trace collection"
description: "This opt-in instrumentation helps builders and researchers locate latency in the ordinary run"
source_path: "docs/trace-spans.md"
---

> [Source: docs/trace-spans.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/trace-spans.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

This opt-in instrumentation helps builders and researchers locate latency in the ordinary run
path while preserving task acceptance, pins, grants, redaction, leases and effect fences. It adds
no product controls or copy. The scoreboard contract remains
[schema 3](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/testkit/src/performance-report.ts), with its complete
[metric manifest](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/testkit/src/scoreboard/manifest.ts) and
[calibrated verdicts](/docs/performance/#paired-verdicts-and-policy-calibration).

## Enable and consume

In a benchmark composition root, use the new
[`startScoreboardTrace`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/adapters/src/scoreboard-trace.ts):

```ts
const trace = startScoreboardTrace({ capacity: 8192, sampleRate: 1 });
try {
  await runSelectedTrial();
  const batch = trace.snapshot();
  // Hand the batch to collectTraceEvidence outside the timed product path.
} finally {
  trace.stop();
}
```

The collector is disabled by default. It performs no export, database write, network request,
timer or asynchronous delivery. Its fixed-size buffer drops new points when full; `recorded`,
`dropped`, `sampledOut` and `invalid` counters accompany every snapshot. `drain()` releases buffered
points and retains lifetime counters and sequence numbers. Drain batches are disjoint; do not
combine overlapping snapshots. Sampling hashes the run identity consistently across processes.
Use sample rate one for declared acceptance trials. Dropped or invalid telemetry invalidates
metric coverage, even when a terminal event is present. The benchmark declares the expected trace
count; the observed count alone cannot establish coverage over submissions that were never seen.

The new [`collectTraceEvidence`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/testkit/src/scoreboard/trace-collector.ts) accepts
batches and a declared boundary set. It produces content-addressed raw trace bytes, artifact and
trace entries, derived operation intervals, waiting intervals, coverage, and registered metric
fragments. Merge those fragments into the existing report's complete registries; do not replace
the report with a subset. Supply one trace per paired trial so pair identities are unambiguous.
Consumers including the versus harness can use this interface without changing the executor.
Observation IDs are opaque digests of session, pair, trace and metric identities. Independent paired
trial fragments can be combined without restarting an observation counter. Public collector function
signatures remain unchanged for fault-load and packaged-resource consumers.

Only fixed boundary names, opaque identities, sequence numbers, monotonic times, attempt numbers,
outcomes and requested schedule delays are accepted. No tool names, prompts, arguments, result
bodies, provider URLs or error messages enter trace records. Export hashes all retained identities.
Outer fields and point fields are validated; unknown fields cannot smuggle content into artifacts.
Trace buffers are ephemeral. Publication, retention, cross-process collection and immutable indexing
belong to the scoreboard workflow, not to the product hot path.

## Boundaries and clocks

The existing run ID connects the
[`sendThreadMessage`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/apps/api/src/thread-target.ts) receipt, queue job, executor, durable events
and client state. Admission records the authenticated send handler's entry and its committed
transaction. Idempotent receipt replay is a separate marker. A run may include steering or an
approval continuation; collectors retain its original identity and lease attempt numbers.
Steering and approval replies do not overwrite the original admission timestamps.

[`GraphileJobPublisher.enqueue`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/adapters/src/wakeup.ts) records submission and
successful enqueue acknowledgement; `GraphileJobWorkerHost` records dequeue. Eligibility falls
within the publication request/response boundary after the requested schedule delay. Queue duration
therefore retains lower and upper bounds. Failed publication never records a successful enqueue.
If a worker acquires the job before the publisher observes its acknowledgement, the lower bound is
zero and the submission-to-lease upper bound remains valid. Missing or uncalibrated clocks still
produce an unknown interval.
Capacity waiting begins at a rejected concurrency claim. Approval waiting begins at the existing
pause result. Quota waiting begins at an observed HTTP 429. Waiting is retained in total elapsed
time; partial waits are unknown, not zero. Poll intervals are not used to invent queue durations.
The optional `TracePoint.requestId` preserves the logical provider request across retries, while
`operationId` identifies each HTTP attempt and `attempt` remains the run lease attempt. Quota waits
close only at another HTTP attempt of that request in the same process and lease attempt. Older
version-1 batches without `requestId` remain readable, but their quota waits stay unknown. This is
an additive trace-field change; raw-artifact consumers must allow and scrub the new opaque field.

[`createRunExecutor`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/adapters/src/executor.ts) records acquired leases, context readiness,
runtime activity, raw text, first safe text after the streaming redactor, durable progress, and each
tool invocation/result. Tool intervals include the ordinary authorization and effect path; finer
tool setup, permission and durable-result components are not inferred. The existing request ledger
continues to own all usage arithmetic.

For supported Pi HTTP routes, [`observePiUsage`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/adapters/src/pi-request-usage.ts) uses
the existing request/attempt identity to record actual HTTP attempts, the first parsed protocol
payload, first text delta and outcome. This first protocol payload is distinct from response
headers or first network byte. Failed attempts remain present. Native internal provider spans and
unsupported Pi transports remain unavailable; runtime-level activity is not relabeled as a native
provider request.

The new optional `FinalizeRunBase.onCommitted` observation in
[`finalizeRun`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/db/src/events.ts) runs after a successful transaction and before realtime
notification. Transaction retries cannot produce extra commit observations. Telemetry exceptions
are isolated. Executor-confirmed cancellation is recorded only when `confirmDispatchStop` succeeds;
other cancellation owners and recovery paths still require their own coverage validation.

All local durations use `performance.now()`. Process identities are explicit. Cross-process
subtraction requires an observed request/response clock calibration with a declared validity window
and drift allowance. [`calibrateTraceClock`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/testkit/src/scoreboard/trace-collector.ts)
retains offset uncertainty; stale, reversed or absent calibration produces an unknown duration.
No implicit wall-clock synchronization is assumed. This follows the process-relative clock in
the [Node performance API](https://nodejs.org/api/perf_hooks.html#performancenow).

Service intervals are unioned within each trace before computing a residual. Overlapping provider
and tool intervals count once. That residual includes queue, setup and waits; it is not a measurement
of harness CPU. Cross-process or unfinished service work prevents this derivation. Percentile
summaries are never subtracted to manufacture overhead. User metrics begin at client submission;
the separate `admissionToTerminal` diagnostic must not be labeled user end-to-end time.

## Client paint and coverage limits

Before navigating a selected web benchmark, set `globalThis.__ardurTrace = { capacity: 8192 }`.
This test-only hook enables a lazy collector through the existing
[`RPCLink`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/apps/web/src/lib/rpc.ts). Normal startup does not import the collector. A failed
collector import falls back to the ordinary RPC exactly once. Submission is captured before the
lazy import, retaining its cold-load latency. RPC submission begins after composer
preparation and attachment upload; whole gesture-to-send latency is a separate, currently missing
boundary. Receipts bind those timestamps to every returned run ID, including when events arrive
before the receipt. Repeated sends into an existing run do not create a new turn identity.

[`paintThreadTrace`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/apps/web/src/lib/scoreboard-trace.ts) is called from the committed Shell
snapshot. Text requires a streamed/durable-content event, corresponding nonempty rendered content,
a nonempty DOM box intersecting the viewport and every overflow clipping ancestor, visible style
and a visible document. Persisted message sequence numbers are independent of event sequences;
event consumption uses the snapshot cursor, and durable messages are matched by message/run identity. Placeholders,
offscreen responses and tool activity do not qualify. A
terminal event requires the matching thread cursor to have committed. Compatible commits keep each
pending two-frame observation and revalidate the latest snapshot. Changing threads or unmounting
cancels pending callbacks. The two-frame convention matches the existing
[`markAfterPaint`](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/apps/web/src/lib/performance.ts); it measures an opportunity to paint, not GPU
presentation. Hidden tabs can pause animation callbacks, as described by
[the browser API](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame).

Coverage is intentionally explicit:

| Route | Instrumentation | Remaining acceptance |
| --- | --- | --- |
| API, Graphile, executor and Pi HTTP replay | Declared local boundaries, per-attempt provider and per-tool intervals | Expanded tasks, load, failures and separate-process clock calibration |
| Shared web Shell | RPC receipt, subscription delivery, text and terminal paint | Real-stack web T2 and whole composer gesture |
| Electron | Hosts the same Shell | Packaged run on an isolated canonical runner; IPC and native presentation |
| Other web views | Shared RPC delivery | View-specific committed paint hooks |
| Mobile | Server trace only | Native event-consumption and paint hooks |
| Native runtimes | Executor/runtime/tool/terminal boundaries | Native internal attempts and real CLI acceptance |

Do not treat a schema, a headless fixture, a single replay or a green build as full T2/T3 acceptance.
The proposed collector budget is max(2% of baseline p95, 5 ms); calibrate A/A runs and freeze a policy
before enforcing it. The stream's startup-JavaScript limit is 1,024 gzip bytes against its parent.

## Reproduce bounded checks

```sh
pnpm exec vitest run packages/adapters/src/scoreboard-trace.test.ts \
  packages/testkit/src/scoreboard/trace-collector.test.ts \
  apps/web/src/lib/scoreboard-trace.test.ts packages/testkit/src/performance-report.test.ts
pnpm --filter @ardurbot/web build
pnpm --filter @ardurbot/web exec playwright test --config playwright.trace.config.ts
```

The production test is opt-in through `SCOREBOARD_TEST_DATABASE_URL`, which must point to a migrated,
disposable loopback database named `scoreboard_trial_1`. `TRACE_PAIRED_SAMPLES=20` runs 20 alternating
collector-off/on pairs, cloning that template per trial; it never uses a product database. Set
`TRACE_REPORT_DIR` to retain each immutable raw result. Failed assertions retain already collected
evidence. This is an instrumentation toggle comparison on one revision, not a parent-commit speed
claim. The ordinary single-trial mode does not provision infrastructure itself.

```sh
VERIFY_DATABASE=1 DATABASE_URL="$SCOREBOARD_TEST_DATABASE_URL" \
  pnpm exec vitest run packages/testkit/src/scoreboard/trace-production.postgres.test.ts
```

No new dependency, schema change, migration, provider setting, Dashboard or release policy is added.
