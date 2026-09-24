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

`perf:compare` continues to support the original packaged-desktop schema and also compares the
smaller offline reports. It warns above 20%, rejects direct interpretation across different machine
classes, and does not fail a merge. `node --import tsx` avoids the CLI's unnecessary IPC listener;
the full desktop benchmark still needs Docker and a display.

`scripts/bundle-budget.mjs` generalizes the original terminal measurement without renaming or
removing `scripts/terminal-bundle.mjs`. It follows the complete static dependency graph from HTML
and manifest entries, gzips each initial JavaScript file once, and warns above **10,240 additional
bytes**. It compares every recorded lazy boundary, including uniquely identified shared chunks,
against the current graph. Eager loading or a missing boundary emits a warning even below the size
budget. A deliberate removal needs review before updating the baseline; automatically accepting a
new manifest would hide that regression. CSS, fonts, and other non-JavaScript assets are excluded
from this particular budget.

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
screenshots are attached to the `shell-performance` artifact for review. The workflow is advisory.

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
