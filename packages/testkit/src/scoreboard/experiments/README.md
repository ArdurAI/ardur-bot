# Durable experiment matrix

This test-only slice helps operators and builders discover lost work, repeated effects,
stale authorization, context loss and queue starvation before a release. It builds on
the [scoreboard manifest](../manifest.ts), [strict replay](../replay/production.ts),
[trace collector](../trace-collector.ts) and production adapters. It changes no scheduler,
provider, product UI, runtime pin or approval policy.

## Run

Use the repository's installed package manager. PostgreSQL and Ryuk images must already
exist in the local Docker engine; the matrix refuses to provision when either is absent.
It never accepts an owner database URL. Each trial clones a disposable migrated database.
Use an output directory on a volume with sufficient free space for expanded measurements.

```sh
node --import tsx packages/testkit/src/cli/scoreboard-matrix.ts --declare=true --output=.context/performance/matrix-plan
node --import tsx packages/testkit/src/cli/scoreboard-matrix.ts --plan=smoke --output=.context/performance/matrix-smoke
node --import tsx packages/testkit/src/cli/scoreboard-matrix.ts --select=O9 --fault=crash-04 --output=.context/performance/matrix-crash-04
SCOREBOARD_MATRIX_POSTGRES=1 pnpm exec vitest run packages/testkit/src/scoreboard/experiments/components.postgres.test.ts packages/testkit/src/scoreboard/faults/process.postgres.test.ts packages/testkit/src/scoreboard/load/queue.postgres.test.ts --maxWorkers=1 --maxConcurrency=2
```

Ordinary unit CI skips durable suites with an explicit prerequisite reason. A skip is not
durable acceptance. Unit fixtures require neither git history nor a particular Node version
or host OS. Native installed-client acceptance and desktop windows are not invoked here.
Set `SCOREBOARD_MATRIX_REPORT_DIR` for the durable fault test to retain content-addressed
observations before assertions and the existing scoreboard evidence fragments after the suite.
The calling verification workflow must bind those files to its before/after source digest.
Fault tests use independent databases and can run concurrently; the command above limits
them to two cases. Use the serial matrix CLI for controlled resource/timing comparisons.

Exit `0` means every selected probe passed its declared checks; `1` means a measured finding;
`2` means incomplete evidence, a missing prerequisite, changed source or a release request
without the complete release comparison. An incomplete result exits 2 even when its checks
record that an observation did not happen. A false check on a passed or finding result, and
any finding, exit 1. Every attempt is retained, including failed starts.
The release verdict is always withheld by this runner.

## Scope and plans

Every O1–O13 ID, variant and guardrail comes from the existing manifest. `catalog.ts` adds
stream ownership without dropping unimplemented features. Smoke/commit dimensions use
100 documents × 1 revision, 0/10 connectors, and 1/4 demands with both arrival models.
Nightly/release dimensions expand to 100/1,000/10,000 documents × 1/20 revisions,
0/10/50 connectors and 1/4/16 demands. Each invocation executes one pass. The declared
20 commit pairs and 200 release pairs are requirements for the comparison workflow,
not observations fabricated by expanding parameter values. Run alternating parent/candidate
passes on the same isolated runner and retain all of them; fixed-release evidence is also required.

The worker pool and database pool each have four slots for load probes. Arrivals use seed 606.
Open-loop arrivals retain their scheduled times even when service is late; fixed-concurrency
arrivals wait for prior completions. Queue handlers perform synthetic durable work and model
maintenance/callback dependencies. They do not substitute for integrated executor/fleet load.

| Experiment | Owner / handoff | Executable subset and remaining coverage |
| --- | --- | --- |
| O1 | W0-8 / W0-9 | Existing comparator and immutable release index; not rerouted through this runner. |
| O2 | W0-6 / W0-7 / W1-10 | Pi HTTP/SSE parsing, byte/Unicode/secret fragmentation, safe PostgreSQL consumer. The short final delta is delayed until just before the finish frame and `[DONE]`; the assembled text is complete only after that delay. Renderer and executor flush cadence remain open. |
| O3 | W0-6 / W1-6 / Chief of Staff | Actual serialized provider requests under time, memory, grant and schema changes; eligibility hashes are not cache-hit telemetry. |
| O4 | W0-6 / W1-5 | Gold fact/negation/supersession/approval/unresolved/source probes, failed/oversized summary and concurrent generation edit; live model quality and summary usage remain open. |
| O5 | W0-6 / W1-2 | Real document/revision scaling and denied scope. A head read that materializes unrelated revisions is a finding (exit 1). No observed read is incomplete (`no-reads-observed`) and exits 2, not a pass. Query count, lock wait and peak heap remain open. |
| O6 | W0-6 / W1-3 / robust integrations | Real catalog/session code with durable grants, revisions, pagination, slow/unavailable transport and execute-after-revoke; full task-level required/optional semantics remain open. |
| O7 | W0-6 / Chief of Staff / fleet | Real Graphile open-loop/fixed-concurrency work and saturated callback negative control; real maintenance/delegation/native placement remains open. |
| O8 | W0-6 / robust integrations | Real Pi HTTP failures for two bots. Auth is not retried and Retry-After of one second is honored. There is no shared admission budget, and a non-numeric Retry-After retries immediately. Both are findings. |
| O9 | W0-6 | All ten SIGKILL boundaries below plus grant revocation and pin mutation controls. |
| O10 | W0-6 / W1-9 / robust integrations | Durable native binding changes, bounded queue overflow, host transport disconnect; installed CLI/login/version/leak acceptance remains open. |
| O11 | W0-6 / fleet | Fake and actual desktop workspace lifecycle. The result passes or fails from those checks. Docker, Podman, SSH and Kubernetes remain gaps until an isolated runner calls `runComputerLifecycle`. |
| O12 | W0-7 | Packaged startup, physical energy, memory sampling, quiet interval and soak; external runner dependency. |
| O13 | W0-7 / fleet | Feature not implemented. Normal initialization remains the fallback; a workspace snapshot receipt does not imply a startup snapshot. |

## Crash oracle

`faults/process.ts` forks a credential-free child, waits for its module-ready handshake,
and kills it only after the child reports the committed boundary. Recovery starts in a new
process against the same PostgreSQL and Graphile state. The fixture side-effect table has no
idempotency uniqueness constraint: duplicate calls remain observable instead of being hidden
by the oracle. The production approval/effect gates remain responsible for safety.
`FaultSandbox` uses the existing desktop provider's real temporary filesystem across worker
restarts. Its command method permits only the executor's directory setup and never launches
a host command. Stored pins and the model actually passed to the runtime are both checked.

| Boundary | Declared outcome | Durable observation |
| --- | --- | --- |
| crash-01 admission before enqueue | Automatic recovery | Nonce re-delivery and reconciler recover exactly one accepted run. |
| crash-02 lease before work | Safe retry | Expired dead-worker lease can be reclaimed without duplicate work. |
| crash-03 intent before action | Safe retry | Intended effect is executed once; revoked grant requires approval; a changed bot pin cannot replace the run pin. A failed revoke or pin control forces this crash's `safetyPassed` to false; an incomplete one leaves it incomplete. |
| crash-04 action before receipt | Explicit uncertainty | The action count stays one and the missing receipt is not guessed successful or retried. |
| crash-05 receipt before terminal | Automatic recovery | Completed effect is replayed from its durable receipt without repeating the action. |
| crash-06 terminal before UI | Automatic recovery | Terminal state survives nonce re-delivery; UI paint itself is not measured. |
| crash-07 pending approval | Automatic recovery | Pending approval survives; no action runs before consent. |
| crash-08 compaction commit | Safe retry | Summary and cursor survive. The retry must not write the summary again. The oracle counts summary writes, because `compactHistory` does not advance `historyCompactionGeneration`. |
| crash-09 memory delivery | Safe retry | The aged original delivery job is retried once. The idempotent fixture records that retry and one revision; arbitrary provider idempotency is not inferred. |
| crash-10 native host disconnect | Explicit uncertainty | Real HostClient observes WebSocket loss with its pin intact; durable native effect stays uncertain and incompatible continuation is refused. |

Each source-loading stage has a five-minute deadline. The interrupt child deadline is one minute
from `prepared`. Recovery keeps that five-minute budget until the child sends `observing`, which
is immediately before the wait (executor cases and crash-09). The parent then allows the 75-second
observation window plus 15 seconds for the oracle reads and the IPC result (90 seconds). The
deadline does not include API startup. The continuous Graphile runner schedules its first stale-lock
sweep within 60 seconds of worker start. The 75-second window is one full sweep plus 15 seconds,
without changing its scheduler or jitter. crash-08 and crash-10 send `observing` when recovery
work begins, so their shorter path stays on the same 90-second budget.
After confirmed process death the fixture expires run leases that are still leased or running by
setting `leaseExpiresAt` to the epoch, and expires computer-execution rows without deleting them.
`runLeaseClockAdvanced` is that run-lease acceleration. `computerLeaseVerdict` is the separate
computer-lease oracle. `computerLeaseReclaimed` is true only when recovery reclaimed the same row.
A retained tombstone is not a reclaim. Crash-02 dies at leased, before any computer lease, so the
advanced run-lease clock is not wall-clock recovery and there is no computer row to reclaim.
Production reclaim updates an existing row and increments its fence. Deleting the row would let the
next acquire insert fence 1 and hide a reclaim regression. When a lease existed and the dead run was queued, leased, or running, recovery must show the same
lease id and a higher fence. `continueRun` also claims waiting_input and waiting_takeover. A retry
of that job calls `acquireComputerExecutionLease` and increments the same row; that higher fence is
a reclaim, not a tombstone violation. The retry does not always run before the observation ends, so
an unchanged row is still that lease. A pending approval is waiting_input, not a finished run.
A terminal run (completed, failed, or cancelled) returns before that acquire and keeps the expired
tombstone. Crash-01 dies before a computer lease
exists. A fresh fence-1 insert there is the create path, not evidence of reclaim. Graphile locks
are aged so production stale-lock reclamation can run without waiting hours. This is a declared
clock acceleration, not autonomous wall-clock recovery evidence. The real native client is used
against a synthetic loopback host; no installed CLI or human acceptance is implied.

Retries use the existing nonce/effect contracts. A completed external action without a durable
receipt must retain uncertainty: see the [AWS idempotent API guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/),
[effect gates](../../../../adapters/src/approval-effect.ts),
[queue implementation](../../../../adapters/src/wakeup.ts), and
[native binding](../../../../adapters/src/runtimes/runtime-session.ts).

## Evidence and interpretation

Artifacts are content-addressed JSON envelopes, written exclusively and indexed with a
read-back check. Their binding includes the base commit, deterministic tracked/untracked diff
digest, dependency lock digest, image digests and sizes, environment and complete manifest.
`matrixEvidence` emits the existing W0-1 `ExperimentEvidence`/`CrashEvidence` fragments for the
scoreboard workflow. Revoke and pin controls are separate attempts (`crash-03-revoke`,
`crash-03-pin`) and count only when they reached their boundary and passed. An incomplete control
leaves the crash incomplete with the missing control named. An unsafe effect observed by any
attempt forces `safetyPassed` to false, even when the base attempt is incomplete. A complete crash
also cites the traces of every durable run it drove: the interrupted and recovering processes of
each attempt merge into one trace artifact, written beside the fragments. Each process must
contribute at least one batch. Those batches are collected again with the required boundaries
stored for that trace. The fault worker stores the list its runtime can emit. A scripted runtime
never emits `provider.*` or `text.published`, so those boundaries are not required for a scripted
crash; a Pi runtime fixture uses the full local list. An empty boundary list is never substituted.
Crash collection pairs a `provider.started` or `tool.started` on the killed process with a finish
on the recovering process that has the same operation id and the next lease fence. A finish on any
other fence does not pair and does not make the crash complete. Each batch carries that process's
`timeOrigin` and `clockUncertaintyMs`. The buffer measures the uncertainty once, from a wall-clock
versus monotonic cross-check, or records the documented default of one second when that check
cannot be made. A cross-process span is a wall-clock interval (`reason: "wall-clock"`) only when
the widened lower bound stays at or above zero: the point estimate is the difference of wall times
(`timeOrigin + at`), and the bounds widen by the sum of the two batches' recorded
`clockUncertaintyMs`, or by one second when neither batch recorded a clock uncertainty. It is never
an exact span. A lower bound below zero is `clock-uncertain`, not `wall-clock`. A batch without
`timeOrigin` leaves the span `clock-not-calibrated`. Wall time that runs backwards is `clock-skew`.
None of those cases subtract the process-local clocks, and none is `reversed-boundaries`. A start
with no finish on the next fence is `interrupted`. An interrupted start, an uncalibrated clock,
clock skew, or an uncertainty interval that crosses zero makes the crash `incomplete` with
`crash-span-unmeasured`, and `safetyPassed` and `recovery` stay unset. The merged trace is accepted
only when both processes contributed a batch and collection is complete: exactly one terminal point,
every required boundary present on the merged trace, a measured crash span, and no batch that
dropped or invalidated a point. One process alone, admission points alone, two terminal points, or a dropped terminal stay
`trace-links-missing`. Ordinary single-process traces still require each start and finish on the
same process and still report an exact span. An incomplete crash must not record a recovery or a
passed safety result. The evidence schema stays the existing crash keys.
Detailed probe results are supplemental raw evidence, not a replacement release schema. All
experiment variants remain incomplete until their full acceptance closes.

Trace collection reuses W0-4 and preserves unknown/unobserved boundaries. Cross-process timing
is not combined without a shared clock. Crash spans use each batch's `timeOrigin` as that shared
wall-clock origin and publish an interval, widened by recorded clock uncertainty or by one second.
An interval whose lower bound is below zero is unmeasured.
Fixture counters do not become provider usage, and hashes do not become
live cache hits. No priced cost is emitted
without dated rate evidence.
Background load, uncontrolled OS caches, absent fixed-release evidence, platform coverage,
subscription quotas and human-review time remain explicit gaps. Follow
[performance measurement guidance](../../../../../docs/performance.md) for paired timing and
platform acceptance. A failing baseline is a finding for its production owner, not permission
for this test-only stream to change product behavior.
