# Department tasks and provider replay

This runner helps builders detect request drift and operators detect incorrect results or unauthorized effects before a release. It adds evidence to the existing [performance contract](../../../../../docs/performance.md), [schema 3](../../performance-report.ts), and [frozen manifest](../manifest.ts). It does not replace their registries, usage accounting, statistical verdicts, or human calibration requirements.

Run from the repository root after installing the existing workspace dependencies and generating the database client:

```sh
pnpm db:generate
node --import tsx packages/testkit/src/cli/scoreboard-replay.ts --tier=T0 --output=.context/performance/contracts
node --import tsx packages/testkit/src/cli/scoreboard-replay.ts --tier=T1 --output=.context/performance/replay
node --import tsx packages/testkit/src/cli/scoreboard-replay.ts --tier=T1 --tools=remote --timing=fixed-delay --output=.context/performance/replay-remote
```

T0 has no services and no timing claim. T1 provisions one disposable PostgreSQL container, applies existing migrations once, clones an empty database for each trial, and runs the real HTTP API, Graphile worker, executor, Pi runtime, and streaming provider parser. The runtime must report that it is not scripted. File tools use an isolated temporary workspace. Record mutations use an ordinary integration adapter and PostgreSQL revision checks. The remote tool variant adds a loopback HTTP boundary; it does not represent an external vendor.

Docker must already be available locally. When the engine exposes a different socket inside its virtual machine, set `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Container provisioning happens before the offline boundary. The CLI removes inherited provider credentials and blocks external Node TCP connections during each trial. This is an in-process egress assertion, not an operating-system firewall. No installed native provider command is launched by T0 or T1.

`--task=task-01,task-04` selects tasks. `--history=long` seeds 204 archived messages, including one attachment-sized message exceeding 40,000 characters, through the database's message writer before the ordinary send path. It requires a separately reviewed `task-XX-long.json` fixture: a missing fixture fails explicitly. `--capacity=16000`, `128000`, or `1000000` runs an estimate-labeled budget simulation over every fully assembled request, including tools and history. These values never change or assert the actual provider context window. The declared output reservation is 4,096 tokens. Capacity simulation is evidence, not provider admission control.

Long fixtures cover one task in each department: 01, 05, 09, 13, 17, and 21. They include three actual compaction requests; the oversized next message remains uncompacted under the existing transcript cap. This proves request construction and transport, not summary quality. The remaining task variants have deterministic material contracts but need their own reviewed long tapes before T1 execution.

The two service schedules are zero delay and fixed delay (40 ms before the first stream chunk, 5 ms between chunks, 20 ms per record tool call). They isolate transport behavior without claiming a measured vendor latency distribution. Every attempt, including a failed or slow trial, remains in the raw report. These commands are correctness smoke runs; timing comparisons require the paired sample plan in the performance contract.

## Fixture review

An explicit `--record=true` run produces a new synthetic reference tape and exits with status 2 even when its outcome passes. It never overwrites an existing fixture and never counts as passing replay evidence. Review the complete prompt, schemas, sequence, response bytes, and declared variables; then rerun without recording. Fixture changes must be reviewed like code. The solver is in `tasks/reference.ts`; the independent outcome oracle is in `graders/outcome.ts`. Neither is copied into the agent workspace or exposed as a tool.

`StrictReplay` matches the complete method, path, and normalized JSON request. Object key ordering is insignificant; array order, schemas, model selection, prompt contents, and undeclared fields remain significant. IDs and timestamps may vary only at declared paths. Two narrow embedded-ID patterns cover the memory citation marker and the bot workspace sentence; memory revision numbers and surrounding instructions remain exact. The timestamp assertion preserves its location and every surrounding byte. A mismatch poisons the entire session, including later retries. Declared graph branches must match exactly one exchange. Headers outside the JSON request are not included in this version's provider request comparison.

Native fixtures exercise the existing Claude stream parser/argument builder and Codex RPC client using fragmented protocol bytes. They are protocol tests; compatibility with installed, unmodified native clients remains separate acceptance.

## Outcomes and coverage

Every fixed task has immutable synthetic files, initial state, allowed tools, consent, a deadline, a reference solver, and a hidden oracle. The grader checks exact facts, source revisions, unresolved conflicts, persisted files, state changes, effect cardinality, scope, pins, terminal state, and deadline. Text delivery alone does not establish success. T0 negative controls deliberately corrupt these dimensions.

The repository repair is a bounded configuration repair with hidden pagination probes, without executing submitted code. Shell diagnosis consumes a supplied diagnostic transcript. The delegated brief consumes preaccepted child records and verifies provenance. The interrupted task consumes an existing durable receipt and requires no duplicate effect. Actual delegation, shell execution, process crashes, and restart recovery are additional production-path coverage owned by the fault/load stream. The existing lifecycle suite also covers approval and effect recovery.

Only synthetic record tools with explicit task consent receive an ordinary scoped allow rule. The fixture service rechecks consent and the expected revision inside the write transaction. Other product authorization, approval, runtime pin, lease, and effect mechanisms remain active. Separate database tests revoke consent after discovery, race writes, replay a receipt, and attempt access from another bot scope.

Reports contain checksummed raw data, the unchanged manifest, and a schema-compatible task evidence fragment. `attachReplayTaskEvidence` adds that fragment to a complete schema-3 envelope supplied by the scoreboard owner, preserving every other metric and coverage gap. It refuses a mismatched build digest or existing task trials. Trace identifiers are correlation references; missing W0-4 span collection remains incomplete. Request usage is read from the existing ledger without turning missing categories into zero. No standalone release verdict or calibration pass is fabricated.

## Explicit live boundary

`runBoundedLive` is the bounded T3 library entry point. The caller must provide a complete route pin, positive request/token/time limits, a route-validated exact counter, and a production transport that honors the output cap and abort signal. It reserves input plus maximum output before dispatch, retains failed attempts, and never refunds reservations. Estimates cannot authorize a hard live budget. `LiveRunError` retains attempt evidence when the run fails.

No live route, credential, price, or quota is selected by default. The CLI refuses T3 until a validated counter and production transport are bound by the route owner. Live-agent success, actual cache behavior, native acceptance, human judgment, subscription quotas, and review minutes remain separate from replay. Human calibration follows the existing schema and release procedure.

Exit codes: 0 means the selected contract/replay checks passed with an unchanged source digest; 1 means a trial failed or was incomplete; 2 means setup/arguments failed or a recording still needs review. Evidence binds to the base commit plus a digest of the tracked diff and sorted untracked source paths/content hashes. Keep report output in the ignored `.context/performance/` directory to avoid including reports in subsequent source digests. Eventual commits must be reindexed and retested by the scoreboard workflow.

The runner writes its binding before trials and each task result before cleanup. These files preserve partial evidence if a later task or process fails. Graphile acknowledgement and immediately runnable compaction jobs are drained before the worker pool closes; run completion alone does not prove the queue finished its bookkeeping.
