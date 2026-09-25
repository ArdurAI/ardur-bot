# Packaged resource collection

This collector helps builders and local-first users see which parts of the installed application
and local stack were actually measured. It adds no product UI, runtime fallback, provider setting,
dependency, migration or startup import. The short scripted diagnostic keeps its existing command
and labels. The [performance contract](../../../../../docs/performance.md), W0-1
[`PerformanceEvidenceReport`](../../performance-report.ts), W0-4
[`collectTraceEvidence`](../trace-collector.ts), and W0-8 comparator remain authoritative.

The new entry point is an explicit mode of the existing runner:

```sh
pnpm perf:desktop -- --canonical --action=plan --mode=commit --output=.context/performance/plan
pnpm perf:desktop -- --canonical --action=assets --renderer=apps/web/dist \
  --main=apps/desktop/dist --preload=apps/desktop/dist/preload.cjs \
  --host=apps/host-service/dist/host-service.cjs --output=.context/performance/assets
```

Use a volume with sufficient capacity for output and temporary profiles. No action installs
packages or downloads images. Run workspace dependency installation, database generation and
production builds separately. `assets` returns 2 when any category is absent. Supply `--asar`,
`--native-modules`, `--installer`, `--download`, and `--installed` from the actual target package
to collect those categories. An empty supplied directory measures zero; an omitted path is unknown;
a nonexistent supplied path is an error. The main directory records the complete emitted tree.
Categories can overlap, and must not be added to calculate installed size. Installed footprint here
means logical file and relative-link bytes, not allocated disk blocks. Inventory files carry
SHA-256 byte digests; the inventory itself has a deterministic content digest. Internal framework
links are recorded without traversing them twice; external and absolute links are rejected.

`createPackagedPlan` predeclares 20 observations per commit build/stratum or at least 100 for a release,
alternating parent/candidate order with fixed-release observations interleaved. Each observation has
a separate reset identity. W0-9 must execute the builds on matched hardware with identical resources,
fixtures, power and cache conditions; collecting a single candidate is not a paired comparison.
The release replay requirement of 200 pairs is unchanged. No budget or statistical verdict is
implemented here.

For actual client replay, write a binding JSON containing `build` from `readSourceBinding(root)`,
`role` (`parent`, `candidate` or `fixed-release`), and `environmentHash` of the separately retained
environment manifest. Keep that manifest explicit about hardware class, OS/runtime/browser versions,
power mode, thermal state, background load and resource limits. Source and artifact digests are
checked before and after the run. The build workflow still needs to attest that source produced
those artifact bytes; checksums alone are not an attestation.

```sh
pnpm perf:desktop -- --canonical --action=run-web --binding=binding.json \
  --renderer=apps/web/dist --output=.context/performance/web
# Only on an isolated display runner, with an already built directory package:
pnpm perf:desktop -- --canonical --action=run-desktop --isolated-runner=true \
  --binding=binding.json --renderer=apps/web/dist --installed=package-root \
  --executable=package-root/executable --output=.context/performance/desktop
```

The desktop executable must be inside the measured package and report `app.isPackaged`; there is
no development-Electron fallback. Headless Chromium is a separate web stratum. Both use the existing
W0-5 long `task-01` fixture, ordinary Pi adapter, real HTTP API, PostgreSQL and Graphile worker.
The fixture is synthetic. Its normal pins, tools, Ask-first policy, revision checks, redaction and
effect fences remain in force. Submission goes through the production composer; the existing
hidden grader checks the saved outcome. For desktop, synthetic cookies are written to the priming
window's partition with a one-hour expiry so the measured relaunch stays authenticated, then the
profile is removed. A fresh loopback listener avoids contacting a running development server. Cached
PostgreSQL and cleanup images are checked before provisioning. Provider credentials are omitted.
`DISPLAY`, `XAUTHORITY`, and `WAYLAND_DISPLAY` are kept so Electron can open the runner's virtual
display. The replay uses its existing loopback network boundary. That boundary is an in-process
assertion, not an OS firewall.

The local driver currently supports process-cold/OS-warm, Chromium-cache-cold and primed warm
relaunch for desktop, and fresh-context Chromium for web. Fresh-install, local-stack-cold and
reboot-cold require physical-runner reset adapters. The initial authenticated profile is prepared
outside the measured interval. Durations use the runner's monotonic clock. Shell readiness,
restored transcript and a graded working turn are distinct observations. User TTFT comes from
W0-4 submission/paint boundaries, including calibration uncertainty, rather than reducer timing.
Paint denotes the existing two-frame opportunity, not GPU presentation.

The API and worker share the runner process in this bounded driver. Host-service pairing,
separate-service resource attribution, database/VM counters, UI lock/unlock and suspend/resume
acceptance remain incomplete until an isolated fleet runner supplies those observations. A failed
attempt remains in the manifest; it is never retried until green or dropped as an outlier.
The local driver does not by itself complete canonical full-stack T2 acceptance.

`ingestClientCapture`, `ingestWebCapture` and `ingestMobileCapture` consume the same strict capture
contract and expected artifact/environment/fixture bindings. Mobile acceptance requires a physical
device declaration and its own trace batches. Desktop data cannot fill a web or mobile cell.
Native mobile paint hooks and physical-runner exports remain integration dependencies, not implied
support. `attachPackagedCapture` merges observations into the complete schema-3 registries and
refuses to replace existing attempts. W0-4 scrubs runtime identities from the retained trace bytes.

```sh
pnpm perf:desktop -- --canonical --action=ingest --capture=capture.json \
  --binding=expected-client-binding.json --output=.context/performance/device
```

`captureStackResources` reads explicitly supplied owned PIDs. Inventory identities describe process
lifetimes and roles; co-located API/worker roles count once. A guest can reference the VM that already
contains its memory. Guest detail is retained but excluded from the host sum. Unknown or mixed
memory definitions cannot produce a complete total. RSS/working-set sums still overlap shared pages;
they are not whole-machine incremental footprint. That separate field stays unknown without a
matched machine control. The portable sampler records RSS and CPU time on macOS/Linux, Linux
high-water/write counters when readable, and private bytes/CPU time on Windows. Unavailable wakeup,
network, high-water and physical-memory counters stay unknown. PID start-time checks catch observed
reuse; Unix `ps` start-time precision is limited, so subsecond reuse still needs a native runner.

`RESOURCE_PROFILES` retains a 60-second stabilization phase followed by 15 minutes of idle,
a separately named 30-minute quiet interval, or a two-hour mixed soak. One-second sample slots are
fixed before collection. Failed and missed slots remain visible, sampling never overlaps itself,
and mixed work runs independently of the sampler. Stopping that work at the end of the window is
not a workload failure; a workload that rejects for another reason still makes the window
incomplete. `captureStackResources` persists each frame before continuing. `attachResourceMetrics`
consumes the complete profile only; failed windows cannot
establish idle/peak means or CPU deltas. Mixed soak requires a declared workload callback through
the library API. High-water values remain in raw per-process records and are not replaced by a
sampled peak. Network/writes are raw counters, not silently equated to process or machine energy.

```sh
pnpm perf:desktop -- --canonical --action=resources --isolated-runner=true \
  --binding=resource-binding.json --processes=owned-processes.json \
  --profile=stabilized-idle --output=.context/performance/resources
```

`EnergySampler` is a physical-instrument boundary. `ingestPhysicalEnergy` accepts instrument joule
counters or integrates measured watts, validates calibration dates/uncertainty and matched idle
control bytes, and rejects missing windows, resets, repeated/reversed samples and power gaps over
one second. CPU-package energy cannot populate system energy. Battery and thermal state are only
metadata: [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor) exposes
state changes, not a joule meter. The existing
[Electron process metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric)
also require platform-specific interpretation. No physical energy instrument is bundled or
calibrated by passing these unit tests.

```sh
pnpm perf:desktop -- --canonical --action=ingest-energy --capture=energy.json \
  --binding=energy-binding.json --idle-control=idle.json --output=.context/performance/energy
```

The supported release matrix is read from `release-desktop.yml`: macOS arm64/x64, Linux x64,
optional Linux arm64, and Windows x64. `packagedCoverage` also keeps web engines and iOS/Android
device coverage explicit; it does not promote those cells to supported releases. Pending platform
and required-energy observations are incomplete. `runPackagedPlan` and `writeImmutableReport`
retain content-addressed bytes locally, including failed and cancelled attempts. W0-9 owns durable
indexing, distributed artifact verification, trusted chronology and release integration. W0-8 owns
calibration and budget decisions. Human/native acceptance and live-provider claims remain separate.

Run deterministic checks without Docker, provider credentials, git history or native windows:

```sh
pnpm exec vitest run packages/testkit/src/scoreboard/resources.test.ts \
  packages/testkit/src/performance-report.test.ts apps/web/src/lib/performance.test.ts
```

Tests use synthetic fixtures and virtual clocks for long profiles; those durations do not constitute
resource or timing measurements. No elapsed-time improvement follows from replacing a five-sample
diagnostic. Collect matched raw parent/candidate/fixed-release evidence and calibrated verdicts
before making performance claims. The startup-JavaScript limit for this stream is 1,024 gzip bytes.
