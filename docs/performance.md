# Desktop performance benchmarks

Ardur Bot measures the production Vite renderer inside a packaged Electron directory build against a
disposable Postgres database, the scripted agent runtime, and the fake sandbox. No provider account
or production data is used.

Run the full benchmark with Docker available and permission to open Electron windows:

```sh
pnpm perf:desktop -- --label=before
```

The command uses `CONDUCTOR_PORT` and the next allocated port for its web and API servers. Reports
are written to `.context/performance/<label>.json` and `.md`, which remain local to the workspace.
Override the number of cold and warm launch samples when iterating:

```sh
pnpm perf:desktop -- --label=quick --samples=2
```

To compare packaged assets with remote asset loading under a deterministic network delay:

```bash
pnpm perf:desktop -- --label=remote-80ms --asset-delay=80 --remote-renderer
pnpm perf:desktop -- --label=bundled-80ms --asset-delay=80 --skip-build
```

On macOS, compare destroy/recreate against the retained warm window with:

```bash
pnpm perf:desktop -- --label=reopen-destroyed --disable-warm-window
pnpm perf:desktop -- --label=reopen-retained --skip-build
```

After changing one performance-sensitive behavior, record another report and compare them:

```sh
pnpm perf:desktop -- --label=after
pnpm perf:compare .context/performance/before.json .context/performance/after.json
```

## Definitions

- **Cache-cold launch** uses a fresh copy of an authenticated profile and clears Chromium's HTTP and
  code caches before navigation. It is not an OS-filesystem cold start.
- **Warm launch** fully quits and relaunches Electron while preserving the primed profile and caches.
- **Shell usable** means authenticated bots and the active 100-message thread have committed and
  painted.
- **Settings painted/settled** separates React content paint from the end of the panel transition.
- **Typing** records keydown to the next animation frame with a 100-message transcript mounted.
- **Idle CPU/memory** samples every second for 12 seconds. Summed working-set memory is retained
  alongside raw per-process samples; Chromium working sets can double-count shared pages.
- **Streaming** drives the real subscription/reducer path with scripted progress every 50 ms.

Runtime CPU and launch measurements are informational until enough samples exist on a fixed Mac.
Bundle sizes are deterministic enough for automated regression checks. Keep hardware, platform, and
build mode fixed. A comparison that intentionally changes Electron or renderer mode measures the
combined migration result; it cannot attribute the change to either layer in isolation.

## Install and performance baseline — 2026-09-24

Machine class: Apple M5 Pro, 15 logical CPUs, 48 GiB RAM, macOS arm64, Node 26.7.0.
No hostname, account identity, production data, or provider account is part of these reports.
The two offline runs each use 20 warmups followed by 200 measured samples; values below are medians.

| Measurement | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Initial production JS, gzip level 9 | 397,771 bytes (388.45 KiB) | 398,073 bytes (388.74 KiB) | +302 bytes; below +10 KiB budget |
| Shell preparation, offline render proxy | 0.272875 ms | 0.275708 ms | +1.04%; below +20% budget |
| Submit receipt to first token, offline reducer proxy | 0.002625 ms | 0.002750 ms | +4.76%; below +20% budget |
| Active-run timer callbacks per simulated minute | 61 | 12 | Two old timers versus one combined tick; 80.3% fewer |
| Stop-check invocations per simulated minute | 60 | 12 | 80% fewer; each check retains both database lookups |
| Lease-renewal invocations per simulated minute | 1 | 1 | Renewal cadence preserved |
| Execution heartbeat timers after cleanup | 0 | 0 | No execution timer persists while idle |
| Browser cold shell paint / first token / motion FPS | Not measured locally | Not measured locally | Sandbox refuses a listening preview socket |
| Packaged desktop idle CPU with stack running | Not measured locally | Not measured locally | Docker socket unavailable; no near-zero CPU claim |

The shell proxy renders the actual `ShellSkeleton` through React's server renderer. The token proxy
feeds an immediate asynchronous fake provider through `applyThreadSendReceipt` and
`reduceThreadSnapshot` with 100 historical messages. It excludes browser startup, DOM paint,
network transport, backend dispatch, and provider inference. Neither value is a user-visible cold
launch or full send latency. The skeleton and reducer logic were unchanged between these two
samples; small timing differences are harness noise, not a claimed optimization.

The timer measurement uses fake time in `execution-heartbeat.test.ts`. The prior one-second stop
interval and minute heartbeat produce 61 scheduled callbacks per active minute. The new five-second
shared tick produces 12, still renewing leases once a minute. It suppresses overlap on slow database
calls and aborts execution on check or renewal failure. The tradeoff is up to **five seconds plus the
database round trip** to observe a stop request, compared with one second before. This is an active
execution measurement, not evidence that desktop or Docker idle CPU improved. Existing computer
lease release logic is preserved; full-stack idle acceptance must also confirm computers stop when
released.

Raw safe proxy summaries are in `docs/performance/offline-baseline.json`. The initial bundle and
all 24 lazy boundaries are recorded in `docs/performance/bundle-baseline.json`. Reports and traces
under `.context/performance/` are ignored by git.

## Advisory budgets

```sh
PERF_REPORT_FILE=.context/performance/proxy-before.json pnpm perf:proxy
# After a change, on the same machine and runtime:
PERF_REPORT_FILE=.context/performance/proxy-after.json pnpm perf:proxy
pnpm perf:compare .context/performance/proxy-before.json .context/performance/proxy-after.json
pnpm --filter @ardurbot/web build
node scripts/bundle-budget.mjs apps/web/dist docs/performance/bundle-baseline.json
pnpm --filter @ardurbot/web exec playwright test --config playwright.performance.config.ts
```

`perf:compare` continues to read the original packaged-desktop schema and smaller offline reports.
The proxy comparator warns above both **5% and 25 ms** and rejects mismatched machines, missing or
extra metrics, negative values and empty samples. Historical summaries remain diagnostics; they
cannot establish paired release evidence. Use the direct comparator below when consuming its
distinct exit codes. The older `perf:compare` wrapper does not preserve a nonzero child exit code.
Development checks remain advisory. `node --import tsx` avoids the CLI's unnecessary IPC listener;
the full desktop benchmark still needs Docker and a display.

`scripts/bundle-budget.mjs` generalizes the original terminal measurement without renaming or
removing `scripts/terminal-bundle.mjs`. It follows the complete static dependency graph from HTML
and manifest entries, gzips each initial JavaScript file once, and warns above **10,240 additional
bytes**. It compares every recorded lazy boundary, including uniquely identified shared chunks,
against the current graph. Eager loading or a missing boundary emits a warning even below the size
budget. A deliberate removal needs review before updating the baseline; automatically accepting a
new manifest would hide that regression. It also inventories total renderer bytes, CSS and fonts,
including deferred files, separately from initial gzip JavaScript. Comparable artifact categories
warn above **5%** growth. Main/preload/host bundles, ASAR, native modules, installers, downloads and
installed footprints must be supplied by the packaged collector; absent categories stay incomplete.

## Paired verdicts and policy calibration

The schema-3 comparator consumes checksum envelopes from
`createPerformanceEvidenceEnvelope` in `packages/testkit/src/performance-report.ts`. It uses the
existing manifest, parsers, comparability checks and required-evidence selection. Both baselines are
mandatory:

```sh
node scripts/performance-budget.mjs parent.json candidate.json fixed-release.json policy.json
```

Standard output is JSON; standard error is a brief human summary. Exit **0** means the selected
evidence passes, **1** means a known regression or safety failure, and **2** means incomplete or
inconclusive evidence. Every result retains raw report envelopes, comparisons and machine-readable
reasons. A required release invocation must also require `mode: "release"` and
`releaseEligible: true`; a commit pass is advisory and cannot authorize publication. This comparator
does not replace human acceptance. The desktop release workflow calls it from the evidence job,
which is the publication gate: publication also requires the measured build digests to match the
final distributed files, coverage of the required desktop platforms, and physical energy for those
platforms. Signing or repackaging changes those bytes, so the gate must be run again on the final
files. A failed attempt stays in the index and does not erase an earlier measurement.

Create a policy using `createBudgetPolicy(required, options)` in
`packages/testkit/src/scoreboard/statistics.ts`. Options bind the environment hash, exact scenario,
commit/release mode, analysis seed and resample count. Required IDs come from the existing manifest.
Declare nominal queue load to enable its absolute target, the tool termination deadline separately
from Stop acknowledgement, and an explicit retained-session growth envelope. Retained memory also
requires the two-hour soak evidence. Required metrics without a declared budget stay incomplete;
diagnostic-only metrics check coverage without asserting a numeric improvement.

Policies start proposed. Before collecting a release candidate, call
`freezeBudgetPolicy(proposed, calibrationReportEnvelopes, frozenAt)` with at least two distinct,
clean A/A reports of the same build and scenario. They must satisfy the sample plan, required
coverage and unchanged numeric budgets. The result includes the calibration reports and a policy
digest. Persist and pin that digest before candidate collection. Evaluation revalidates calibration,
rejects policy mutation, requires calibration timestamps before the freeze and the candidate
timestamp after it. Thresholds are never fitted to candidate results. The workflow must establish
trusted chronology and verify the referenced raw/build bytes; a checksum alone is not an attestation.
No production policy is calibrated merely by adding these functions or passing synthetic tests.

The retained proposed values come from `SCOREBOARD_MANIFEST.proposedGates`:

| Guardrail | Budget |
| --- | --- |
| Commit timing warning | Increase above both 5% and 25 ms |
| Release timing | Adjusted upper bound at most max(10% of baseline, 25 ms) |
| Healthy-path p95 | Acknowledgement 100 ms; safe content to paint 50 ms; nominal queue 250 ms; Stop acknowledgement 1,000 ms |
| Prompt tokens | max(5%, 128 tokens), including retries and compaction |
| Warm cache-token ratio | Drop at most five percentage points |
| Initial gzip JS | Growth at most 10,240 bytes; protected lazy boundaries remain deferred |
| Total artifact categories | Growth at most 5%, per platform, against parent and fixed release |
| Idle / peak memory | max(10%, 32 MiB) / max(15%, 64 MiB), with identical accounting |
| Measured energy | Growth at most 10%; missing required energy cannot pass |
| Critical safety | No wrong pin, unauthorized or duplicate effect, lost work, false completion, invalid recovery or critical fact loss |

The comparator bootstraps whole paired sessions with a fixed Mulberry32 analysis seed. A pair ID
identifies the same observation across builds; a session ID groups dependent observations. The
mapping between baseline and candidate sessions must be one-to-one. Reordering input arrays cannot
change a result. P50/p95 estimates and two-sided percentile intervals are reported for all outcomes
and each populated outcome stratum. Changed success/failure pairings are incomplete rather than a
chance to report a faster failure. No observation, failed attempt or slow valid sample is removed.

Bonferroni allocation divides the 5% error budget across predeclared families, family members, both
baselines, two relative statistics plus an absolute target, and all six outcome strata. This is
conservative; each bootstrap tail must have at least ten expected resamples or analysis is
incomplete. The default 20,000 resamples suits a single required metric; larger selections must
declare more resamples before collection. All timing scenarios require at least 20 independent
pairs in commit mode, 200 for release replay/live, and conservatively 100 for release T2 strata.
Populated outcome strata must meet the same minimum. Tails from short commit runs remain provisional.
The statistical method is an approximation whose adequacy must be checked during real calibration;
it does not imply exact finite-sample confidence coverage. See the primary
[bootstrap method documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html)
and [Bonferroni interval definition](https://www.itl.nist.gov/div898/handbook/prc/section4/prc473.htm).

A negative degradation interval means improvement, an upper bound inside the margin means within
budget, a lower bound beyond it means regression, and an overlapping interval is inconclusive.
Exact equality is within budget, with only floating-point roundoff absorbed at the boundary.
Safety and lazy-boundary failures block deterministically even when timing improves. A difference
between distribution percentiles describes a shift; it is never called harness overhead. Collectors
must derive overhead from each trace before aggregation.

Two-file proxy and schema-1/2 desktop inputs remain readable but return incomplete because summaries
do not supply paired raw evidence. `bundle-budget.mjs` with no baseline measures assets only. With
parent and fixed-release files it returns static diagnostics; schema-3 evidence is still required
for calibration, artifact provenance and a release pass. Missing native platforms, energy
instruments or live-provider evidence remain explicit gaps. The release workflow now binds that
comparison to the packaged bytes before publication.

## Evidence index

The historical scoreboard is the local directory `.context/performance/scoreboard-index`.
`records.jsonl` is an append-only hash chain. Raw schema-3 envelopes live under `objects/` and are
named by the SHA-256 of their canonical bytes. A record is appended only after those hashes match.
The directory is local-first and is not a hosted telemetry store. Public records use synthetic
tasks and hardware-class labels.

Commit object bytes are retained for 180 days. Pruning removes only those bytes, writes an expiry
record first, and leaves the original line in place. Release objects are not pruned.
A pending record is never deleted to hide an earlier measurement. A later rejection is a new line;
the measured line remains.

Workflow artifacts expire after 90 days and are not the historical scoreboard. Release evidence is
attached to the GitHub release and kept for the github-release-lifetime of that release. Development
pushes record every new commit as measured or pending and stay advisory. The release invocation is
mandatory: `publish` depends on the evidence job, and that job fails closed when the report,
platform, energy, or digest check is incomplete. Credential-free pull-request runners do not receive
provider credentials. Live provider evaluation stays explicit and budgeted. Physical release runners
are not provisioned by this workflow; until they upload `scoreboard-reports`, publication stops
with the missing evidence visible.

The commit sample plan is 20 paired observations. The release plan is 200 replay pairs and 100
observations per startup stratum. Startup strata that this gate did not collect stay labeled
unknown. Human acceptance is separate and is not granted by the evidence.

The `performance` workflow uses the production Vite build with synthetic auth/RPC responses and a
fake streamed provider; it has no Docker or hosted-provider dependency. It measures five fresh
browser contexts with HTTP cache disabled, using the shell's existing `rk:renderer:shell-painted`
mark. That is navigation to painted authenticated shell, not OS process cold start. Composer-submit
to the first streamed token appearing in the DOM is recorded separately. It compares the previous
revision and current revision on the same Ubuntu runner, and emits warnings above **20%**.

The browser test captures Playwright traces and Chromium timeline traces for message arrival,
bot switching, and both side-panel transitions. Animation-frame markers within those traces report
the slowest observed frame interval: target **60 fps**, warn below **50 fps** (over 20 ms). This is a
main-thread frame-scheduling proxy, not a claim about GPU presentation on every display. Missing
samples or reports are visible warnings, not silently green measurements. Trace archives and
screenshots are attached to the `shell-performance` artifact for review. The commit workflow is
advisory. It builds the base revision in its own worktree and keeps the benchmark runner in a
third worktree. It does not copy candidate production files into the baseline. A baseline without
a compatible in-tree harness is recorded as pending.

## Motion audit

- Message arrival already streams through the shared event reducer and transcript scroll-follow
  logic. Bot switching retains the existing immediate route/state behavior. No library or new
  decorative animation was added to either path without a browser measurement.
- The side panel formerly changed between zero and full width immediately. Its fixed-width surface
  now transitions only transform and opacity over 200 ms. Desktop space changes once at toggle;
  transcript width is never interpolated. Closed content remains for the exit transition and is
  inert immediately, then unmounts. This costs one extra retained surface for at most 200 ms.
- Navigation already limits its transition properties to transform and opacity. Shimmer and both
  success animations already use `motion-reduce:animate-none`; shimmer also restores readable
  static text. New regression tests cover those rules and the panel's reduced-motion transition.

## Remaining real-machine check

With the stack running, run `pnpm perf:desktop -- --label=idle-acceptance --samples=5` on a machine
where Docker and Electron can run. Inspect the 12 one-second CPU samples, then confirm the absence
of continuing execution timers and the release of idle computers. Record CPU median and p95 for
foreground and hidden windows, using the same app/stack versions. Do not run the desktop Playwright
suite on a maintainer's desktop as routine validation. Windows/Linux installers, native frames,
tray visibility, and cold launch still need real-machine acceptance.
