# Bounded restart draining and saved turns

Date: 2026-10-05

Operators can update a busy team without waiting for all bots to be idle together. Builders can restart the API and worker while keeping completed model and tool work. The runtime and model pins remain the same.

A planned update closes turn admission in the shared deployment settings. Every claim reads that state while holding the deployment settings row's read lock; the updater's write takes the same lock. Existing turns stop independently at their next model or tool boundary. Both services use a 60-second drain deadline. The Compose API and worker stop grace is 90 seconds.

The executor encrypts a versioned turn checkpoint with the existing secret store. It contains the conversation, runtime state, pinned destination and effect receipts. Known secrets are redacted before encryption. The turn checkpoint has its own field so screen takeover markers remain independent. Usage, budgets, cancellation and approvals keep their existing durable records.

Every effect records an intent before execution and a result afterward. A completed effect supplies its saved result during recovery. An intent with no result pauses for a person to check its outcome; it never automatically repeats a command or external action. A pending approval is still governed by its existing approval record.

Checkpoint writes require the current run owner and lease fence. Suspension requires a saved checkpoint and releases the run lease without marking the run failed or cancelled. The existing reconciler finds the released or expired lease and the existing claim path continues the same run. An old worker cannot save over a newer lease.

Recovery starts a fresh runtime session with saved context and records: “This run continued in a new session after a restart.” It does not claim that a native session was restored. Web, desktop and mobile project the same suspended/resumed events and show: “Updating — your bots will continue after the update”.

The updater waits for a successful drain immediately before recreate. A missed deadline leaves the current services running, restores the image pin, reopens admission and says: “Update paused because a bot is still working. Try again.” The updater also clears admission after a failed recreate and its recovery attempt. A drain request has an identity so an old completion cannot clear a newer request. Admission has a 65-minute expiry if the updater disappears. This covers the existing 30-minute recreate and 30-minute recovery limits plus restoration and cleanup. Normal completion or failure reopens admission through the API; reopening retries briefly while the API comes back. If the API remains unreachable, the update reports paused bot work rather than claiming recovery succeeded.

## Trade-offs

Saving after each boundary adds storage and encryption work. This is necessary to recover from an unplanned stop; saving only when updating leaves crashes without turn progress. A fresh session may phrase its continuation differently from the original session, but it uses the same pin and saved context. An uncertain effect needs human review, which is safer than guessing whether it happened.

The updater must be able to reach the API drain endpoint. A server that predates that endpoint refuses an automatic recreate through the new updater. Database migrations and browser journeys need CI validation. Computer updates and general process supervision remain separate.

```mermaid
sequenceDiagram
    participant Updater
    participant Admission as Shared admission
    participant Executor
    participant Progress as Saved turn
    Updater->>Admission: Close turn claims
    Executor->>Progress: Save model/tool boundary with lease fence
    Executor->>Admission: Release run ownership
    Updater->>Admission: Check active leases within deadline
    alt All turns saved or finished
      Updater->>Executor: Recreate services
      Executor->>Progress: Claim and continue saved run
    else Deadline missed
      Updater->>Admission: Reopen claims; pause update
    end
```

## Validation evidence

A deterministic two-bot workload was run against the old executor and the changed executor. Both variants reached the same scripted model boundary before interruption. The old executor saved and resumed no turns and failed both. The changed executor saved and resumed both, with no failures, cancellations or deadline misses. Its measured drain time was 94 milliseconds in that run. The old executor had no drain step, so its recorded zero milliseconds is not a comparable drain measurement.

| Count | Old executor | Changed executor |
| --- | ---: | ---: |
| Active turns at restart | 2 | 2 |
| Saved turns | 0 | 2 |
| Resumed turns | 0 | 2 |
| Failed interruptions | 2 | 0 |
| Cancelled interruptions | 0 | 0 |
| Deadline misses | 0 | 0 |

The offline executor, reconciler, queue and boundary suite passed 427 tests; four existing tests were skipped. Native runtime and bridge checks passed 196 tests. Updater checks passed 28 tests and drain endpoint checks passed five tests, logging and command recording passed 573 tests, and client and catalog checks passed 314 tests. These suites overlap and should not be added together as unique test coverage.

Restoring the old executor made seven restart tests fail. Restoring the old queue made two drain tests fail, and restoring the old updater made two recreate-order tests fail. The old Pi boundary made one test fail. Restoring the old native runtime and bridge boundaries made three acknowledgement tests fail. Removing the empty-credential guard made two endpoint tests fail. Removing the reopening retries made two updater transport tests fail. Each temporary restoration or mutation was undone after the test.

The shared shutdown helper is covered for both API and worker: it holds the runtime signal open until safe progress leaves, then interrupts remaining calls at the 60-second deadline. A non-answering lease-count query also reaches the deadline. Reopening admission retries briefly if the API disappears during recreate or recovery; persistent unavailability is reported, and the durable admission expiry prevents a permanent pause.

All changed packages and services passed type checking. Formatting, clean catalog extraction and website facts checks passed. Database migrations and journeys, browser screenshots and hosted checks remain for CI. Nine existing local Hermes tests could not bind a loopback listener in the restricted environment; their runtime behavior remains unverified there.
