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
without the complete release comparison. Every attempt is retained, including failed starts.
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
| O2 | W0-6 / W0-7 / W1-10 | Pi HTTP/SSE parsing, byte/Unicode/secret fragmentation, safe PostgreSQL consumer; renderer and executor flush cadence remain open. |
| O3 | W0-6 / W1-6 / Chief of Staff | Actual serialized provider requests under time, memory, grant and schema changes; eligibility hashes are not cache-hit telemetry. |
| O4 | W0-6 / W1-5 | Gold fact/negation/supersession/approval/unresolved/source probes, failed/oversized summary and concurrent generation edit; live model quality and summary usage remain open. |
| O5 | W0-6 / W1-2 | Real document/revision scaling and denied scope. A head read that materializes unrelated revisions is a finding. Query count, lock wait and peak heap remain open. |
| O6 | W0-6 / W1-3 / robust integrations | Real catalog/session code with durable grants, revisions, pagination, slow/unavailable transport and execute-after-revoke; full task-level required/optional semantics remain open. |
| O7 | W0-6 / Chief of Staff / fleet | Real Graphile open-loop/fixed-concurrency work and saturated callback negative control; real maintenance/delegation/native placement remains open. |
| O8 | W0-6 / robust integrations | Real Pi HTTP failures for two bots. Auth is not retried and Retry-After of one second is honored. There is no shared admission budget, and a non-numeric Retry-After retries immediately. Both are findings. |
| O9 | W0-6 | All ten SIGKILL boundaries below plus grant revocation and pin mutation controls. |
| O10 | W0-6 / W1-9 / robust integrations | Durable native binding changes, bounded queue overflow, host transport disconnect; installed CLI/login/version/leak acceptance remains open. |
| O11 | W0-6 / fleet | Fake and actual desktop workspace lifecycle; `runComputerLifecycle` also accepts existing Docker, Podman, SSH and Kubernetes providers on isolated runners. |
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
| crash-03 intent before action | Safe retry | Intended effect is executed once; revoked grant requires approval; a changed bot pin cannot replace the run pin. |
| crash-04 action before receipt | Explicit uncertainty | The action count stays one and the missing receipt is not guessed successful or retried. |
| crash-05 receipt before terminal | Automatic recovery | Completed effect is replayed from its durable receipt without repeating the action. |
| crash-06 terminal before UI | Automatic recovery | Terminal state survives nonce re-delivery; UI paint itself is not measured. |
| crash-07 pending approval | Automatic recovery | Pending approval survives; no action runs before consent. |
| crash-08 compaction commit | Safe retry | Summary/cursor survive and a retry retains the gold probes and generation. |
| crash-09 memory delivery | Safe retry | The aged original delivery job is retried once. The idempotent fixture records that retry and one revision; arbitrary provider idempotency is not inferred. |
| crash-10 native host disconnect | Explicit uncertainty | Real HostClient observes WebSocket loss with its pin intact; durable native effect stays uncertain and incompatible continuation is refused. |

Each source-loading stage has a five-minute deadline; the interrupt child deadline is one minute.
Recovery has a 90-second child deadline and a 75-second observation window.
The continuous Graphile runner schedules its first stale-lock sweep within 60 seconds. The memory
and executor cases allow one complete production sweep plus 15 seconds without changing its scheduler or jitter.
After confirmed process death the fixture expires run/computer leases and ages Graphile locks,
so production stale-lock reclamation can execute without waiting hours. This is a declared
clock acceleration, not autonomous wall-clock recovery evidence. The real native client is
used against a synthetic loopback host; no installed CLI or human acceptance is implied.

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
scoreboard workflow. Detailed probe results are supplemental raw evidence, not a replacement
release schema. All experiment variants remain incomplete until their full acceptance closes.

Trace collection reuses W0-4 and preserves unknown/unobserved boundaries. Cross-process timing
is not combined without clock calibration. Fixture counters do not become provider usage,
and hashes do not become live cache hits. No priced cost is emitted without dated rate evidence.
Background load, uncontrolled OS caches, absent fixed-release evidence, platform coverage,
subscription quotas and human-review time remain explicit gaps. Follow
[performance measurement guidance](../../../../../docs/performance.md) for paired timing and
platform acceptance. A failing baseline is a finding for its production owner, not permission
for this test-only stream to change product behavior.
