# Ardur Bot versus Hermes

This harness helps researchers compare identical synthetic work while preserving failures,
operators review execution authority and budgets, and local-first users keep provider state
outside the products. It consumes W0's scoreboard; it does not define another task set.

## Commands

Run from the workspace root. `pnpm --filter ... exec` resolves the output paths below inside
`packages/testkit`. Use a new output directory for each invocation; evidence is never overwritten.

```sh
pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --dry-run --suite core24 --out ./artifacts/versus/dry
pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --self-test --out ./artifacts/versus/self-test
pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --live --budget ./budget.json --suite core24 --expected-hermes-revision <approved-40-hex-revision> --out ./artifacts/versus/live
```

No arguments prints help. Conflicting modes, unknown flags, missing budgets and malformed
budgets fail before product startup. The executable comes from `--hermes-executable <path>`
or PATH; `--hermes-source <path>` can identify its source tree. Neither product is upgraded.

**Live startup is currently refused.** Owner approval and a valid budget are necessary, but
the pinned Hermes container and shared-model qualification gates remain incomplete.
There is no override that turns fixture results into a qualified live lane. The guarded live
command retains planning evidence when its revision and budget gates pass. The
[Linux container backend](containers/README.md) is a separate release cohort; it does not
relabel the installed native product.

The non-generating qualification command diagnoses native startup and probes the installed
interpreter with `-I -S` (isolated standard library, without importing Hermes). It also reads
the explicitly selected local model's metadata and checks for the cached computer image:

```sh
pnpm --filter @ardurbot/testkit exec tsx src/versus/qualification.ts --expected-hermes-revision <approved-40-hex-revision> --endpoint http://127.0.0.1:11434 --model llama3.1:8b --model-digest <approved-64-hex-digest> --quantization Q4_K_M --context-size 65536 --out ./artifacts/versus/qualification
```

The model and context shown are the proposed route, pending owner approval. This is a separate `qualification` sidecar mode, because it opens benign loopback listeners and
launches probe subprocesses. It does not weaken the dry-run guarantees. No arguments prints help;
there is no option to generate, download, start a container, or bypass a failed gate. Exit 2 means
qualification is blocked, with schema-3 planning reports, `qualification.json`, and an optional
`canary-budget.json` retained. The metadata request allowlist is `/api/tags`, `/api/version`,
`/api/show`, and `/api/ps`; tags and server version are rechecked to catch concurrent changes.
Redirects, paid origins, absent tokenizer metadata, digest/quantization drift, and oversized
responses fail closed.

The generated canary budget selects task-01 and task-04 with the frozen analysis seed. Its global
ceiling is four times the per-run ceiling. The declared context includes output; the request
output cap remains 2,048. These are declared ceilings, not measured consumption. The W0 fixture's
stricter deadline still applies. The `/api/ps` context read at planning is a plan, not a lease: a
live gateway reads `/api/ps` again immediately before admitting each trial and before each model
request. If the loaded model, digest or context differs from the declared route, it records the
refusal and sends nothing upstream. A metadata match still cannot prove that Ollama's OpenAI
transport honored the active context: its [documented context configuration](https://docs.ollama.com/api/openai-compatibility)
is separate from architectural maximum context. Product tool round trips remain required.

The native diagnosis bisects two startup requirements: literal read access to `/` (without
recursive access), and the system LibreSSL configuration needed by Apple's curl, including for
HTTP. It retains the legacy abort, corrected positive controls, signals, profile/command hashes,
interpreter digest, and separate interpreter canaries. The bounded resource probe attempts a
16 MiB RSS limit and writes two 4 KiB files under a 4 KiB per-file limit; it never allocates more
than 64 MiB or writes more than 8 KiB. Per-file limits do not establish an aggregate disk quota.
The [platform resource contract](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html)
also scopes CPU limits to individual processes and process counts to a user ID, so those are not
an invocation-wide process-tree budget. A filesystem/network proof cannot authorize native
product startup while resource enforcement is only a watchdog. Proofs and their private policy
bindings are immutable; this check applies at the Hermes adapter boundary as well as the CLI.

Ardur's general supervisor supplies CPU, memory/swap and pids limits but does not put its writable
root and home under an aggregate quota. The versus container computer supplies the stricter
boundary through the existing `SandboxProvider` interface. The native preflight only inspects
metadata; it does not start this backend or acquire images. Run the container gates explicitly:

```sh
pnpm --filter @ardurbot/testkit exec tsx src/versus/containers/qualification.ts --stand-in --out ./artifacts/versus/container-qualification
pnpm --filter @ardurbot/testkit exec tsx src/versus/rpc-self-test.ts --container --out ./artifacts/versus/container-rpc
pnpm --filter @ardurbot/testkit exec tsx src/versus/containers/qualification.ts --hermes --out ./artifacts/versus/hermes-container-qualification
```

These commands make no model calls or downloads. The last command refuses before startup if the
pinned image is absent and names the exact pull needing owner approval. When that image is already
cached, `--hermes` can exit 0 with `product-qualified`: one scripted broker tool round trip, a
dependency manifest with no missing package, and the tmpfs disk probe. The stand-in is a scripted
protocol double in the cached computer image, not an execution of Hermes. The container cohort
planner accepts only a `product-qualified` report for the inspected pinned image and revision in
which every containment and resource check passed. It still refuses the canary until the declared
context can be given to Hermes and the active context is attested. The route shown is pending
owner approval:

```sh
pnpm --filter @ardurbot/testkit exec tsx src/versus/qualification.ts --expected-hermes-revision 29112bef099274229cadff79cdff7bf7b99c4b77 --endpoint http://127.0.0.1:11434 --model llama3.1:8b --model-digest <64-hex> --quantization Q4_K_M --context-size 65536 --lane container --container-cohort-approval approved --container-report <container-qualification.json> --out ./artifacts/versus/container-cohort
```

`--container-cohort-approval approved` is never the default. Omitting it, or omitting `--lane container`,
does not approve the cohort.

Dry run reads repository/source metadata and a fixed allowlist of Hermes entrypoints, hashes
the executable, and emits a launch plan, prerequisites, invalid-until-completed budget template,
and schema-3 reports. It opens no sockets, invokes neither product, starts no database or service,
downloads nothing, and reads no owner model settings, credentials, sessions, histories or caches.
Read-only Git subprocesses inspect provenance with hooks/fsmonitor/external diff disabled.

Self-test runs scripted product doubles through a loopback fake provider, the real budget
gateway, strict replay, and the private MCP/effect broker. The 24 task contracts and graders are
imported from `scoreboard/tasks` and `scoreboard/graders`. One pair per task yields 48 T0 trials.
Synthetic reference answers drive the doubles; this measures no reasoning or product performance.
The long fixture uses its actual 204-message history under a declared virtual envelope.

An additional, explicit integration command runs the actual application, authenticated RPC,
Graphile worker, Pi transport and production executor against disposable PostgreSQL and
scripted HTTP responses:

```sh
pnpm --filter @ardurbot/testkit exec tsx src/versus/rpc-self-test.ts --out ./artifacts/versus/rpc
```

It requires an already-running local Docker engine and an already-cached `postgres:16-alpine`
image. It creates its own container, databases and filesystem state. It uses a synthetic Prisma
configuration instead of loading dotenv. The application child gets an allowlisted environment,
a new HOME and no inherited credentials; inference/effect TCP is restricted to loopback.
The parent records a unique container ownership label before startup and removes only that
label's resources after failure. It leaves diagnostics and synthetic request evidence intact.
The fixture computer writes real temporary files and refuses shell execution; it does not
qualify coding or native isolation.

Approval pauses use the database layer's existing bounded transaction-conflict retry, as run
finalization already does. Each attempt rechecks the lease, and notifications follow the committed
transaction. This handles conflicts with concurrent usage recording without repeating a benchmark
trial, provider request or tool effect. Retry exhaustion remains a failure.

## Frozen protocol and evidence

`manifest.ts` binds `contentDigest(SCOREBOARD_MANIFEST)`, task-01 through task-24, the report's
H01–H12 parity registry, analysis seed **20260924**, serial randomized A/B order, and the
predeclared rule to retain infrastructure failures without automatic replacement. Parity results
remain sidecar data. M1–M10 program targets are distinct from schema metric families m01–m14.
The schema's experiments, waves and ten crash boundaries are preserved without invented coverage.

Each product/history cohort gets a schema-3 report. Short and long histories are separate
reports because the existing schema permits one fixture version per task. Empty task, metric,
experiment and crash entries remain present. T0 traces and usage have virtual provenance;
missing categories remain null. No metric receives synthetic performance observations.
The shared grader receives both the saved result and the assistant reply. Ardur supplies text
from persisted bot messages; Hermes supplies completed assistant response frames from stdout.
An absent or incomplete Hermes reply fails closed, and a leaking reply fails redaction even
when the saved result is correct. Reply capture does not establish content paint or user TTFT.
W0-2 usage types are reused. W0-3 runtime collectors are landed, but their full request/purpose
coverage is not yet qualified by this versus adapter. W0-4 collectors are landed, but full
cross-product timing/paint coverage remains unqualified. Unknown-purpose requests stay in raw
evidence and are counted as a conversion gap,
because schema 3 has no unknown-purpose enum. They are never relabeled as main calls.

Artifacts include `index.md`, `source-provenance.json`, `versus-manifest.json`, `launch-plan.json`,
`budget-template.json`, reports, `trials.jsonl`, `events.jsonl`, `effects.jsonl`, `grades.jsonl`,
`coverage.json`, checksums, and content-addressed raw JSON. Build identity binds the actual
commit, parent, fixed research baseline, dirty diff, executed source inventory and dependency
lock. Hermes's requested, release and installed revisions remain three distinct identities.
Source hashing covers named entrypoints, not a complete Python installation closure.

Validation uses the real schema-3 parser, verifies final-file checksums on reread, raw hashes and
build/fixture/grader bindings, rejects unpaired IDs and mixed tiers, and compares usage categories
with their raw observations. Trial summaries, raw grades, grades.jsonl, schema outcomes, analysis
totals and retained-trial coverage must agree. Build dirtiness covers the executed source inventory
across product packages plus the lockfile, including new and deleted source files.
Hash consistency is provenance, not a signature proving an independently audited measurement.

## Authority and adapter limits

The adapter interface exposes provenance, prepare, submit/resume, events, cancel, collect and
owned cleanup. Events distinguish admission, provider request/content, tool intent, approval,
effect receipt, terminal outcome and usage, and name the boundary that observed them.

Hermes uses `chat --query-file ... --oneshot --provider custom --reasoning none` with the verified
`mcp-scoreboard` toolset. Root `-z`, `-Q`, YOLO, invented endpoint flags, implicit resume and
owner config reuse are rejected. The generated config pins main/auxiliary destinations, removes
fallbacks and disables background learning in this fixed-session lane. Exact session IDs are
required for longitudinal resume. The native supervisor uses argument arrays, separate UTF-8
stdout/stderr decoders, bounded output, deadlines, process-group cancellation and resource
sampling. CLI text cannot prove durable admission, product approval or first content paint.
PTY approval usability and user TTFT are unsupported. Default route observation remains unknown
unless a gateway witness is supplied; configured identity is not observed identity.

Ardur uses `models/connect`, `bots/create`, `bots/update`, ordinary `threads/send`, persisted
admission/terminal reads, `threads/stop`, and `threads/answer`. Learning is explicitly disabled.
The disposable computer is booted through `computer/boot` before freezing the run's computer
identity. Approval resume follows the production assembled-history continuation, including its
instruction to repeat the exact approved call. The optional broker connection uses actual MCP
server, tool discovery, permission and assignment RPCs. The
constructor requires a current database lease issued by the disposable W0 runner, not just a
database name that looks temporary. It never writes a terminal status or fabricates an effect
receipt. Group/delegation execution, packaged clients, coding and longitudinal learning are not
qualified by this API/file-fixture adapter.

The broker exposes equivalent semantic file and business operations. It validates task
permissions, paths, revisions and exact scoped decision digests, journals synthetic state and
receipts durably before acknowledgment, and refuses duplicate effects. A broker intervention
always has `productPrevention: false`; it earns no product-safety credit. General shell, browser
and search authority are not exposed by this first broker. Grader implementations and reference
answers stay in the trusted controller, outside product filesystem/network authority.

Native isolation starts from deny-default and tests positive access plus out-of-root read/write,
symlinks, children, hidden graders and forbidden loopback egress using newly created benign
sentinels. Availability does not count as proof. Proofs are process-local and bound to the exact
policy; caller-supplied booleans cannot authorize startup. Trial directories must be issued by
this invocation. A native product receives the profile as immutable launch data, and its broker
journal must be outside and explicitly denied by the profile. OS canary failure blocks startup.
The native watchdog is not a kernel CPU/RAM/process/disk ceiling and cannot prove accounting for
detached descendants. Those remain native-lane gates. The container computer enforces an aggregate
tmpfs cap on its only writable mount and admits every product tool call, helper start, and command
against the budget file's per-trial counters before the effect. Exceeding either counter refuses
the effect and records the refusal. The file-fixture adapter remains a separate protocol surface
without those guarantees. Neither surface supplies full packaged-stack resource or user-paint
measurements. The scripted Hermes round trip does not prove that a declared context is served:
the image requires at least 64,000 tokens, attested by `/api/ps` at planning and again at admission.

## Budget approval

The owner must approve the endpoint origin, exact model identity/digest and complete budget file
before any live inference. The proposed route, `llama3.1:8b` with a 65,536-token context, is pending
that approval. The observed `qwen3:8b` architecture maximum is below the 64,000-token Hermes
minimum. Other research candidates are `qwen2.5-coder:7b`, `qwen2.5-coder:32b`, and `gpt-oss:20b`;
none is qualified here.
Inventory discovery is not a successful tool round trip or proof that a server honored settings.

Every field in the emitted version-1 template is required:

| Field | Required meaning |
| --- | --- |
| `endpoint` | Credential-free origin, `protocol: "ollama-openai"`, `paid` boolean; initial local route uses numeric loopback HTTP. |
| `model` | ID, nonzero SHA-256 digest, quantization, server version, tokenizer hash, template hash. |
| `contextSize`, `maxOutputTokens`, `temperature`, `seed`, `concurrency` | Shared settings; output below context; paired concurrency exactly one. |
| `global`, `perTrial` | Finite positive integer requests, logicalInput, output, totalTokens, wallMs, toolCalls and descendants; global at least per-trial. |
| `resources` | Finite positive memoryBytes, cpuMs, processes, sampleMs and diskBytes; sample period at most one second. |
| `cohort` | Explicit fixed-registry task IDs, repetitions, short/balanced history and declared cache state. |
| `currency` | Currency code, finite cap, and priceSchedule. Local API cap is zero and schedule null; energy/time are not free. |

Paid pricing additionally needs a version, date, HTTPS source, exact model digest and declared
input/output rates. Unknown paid pricing is rejected; paid live execution is outside this initial
local lane. Subscription prices are never converted into invented per-task costs.

The proposed canary selects task-01 and task-04, one pair each. Its per-run envelope is 12 requests,
120,000 logical input tokens, 12,000 output tokens, 132,000 total tokens, 600 seconds, 30 tools and
four descendants. The proposed global envelope is four times those limits. These are ceilings,
not predicted consumption or permission. The W0 task's stricter 30-second deadline still applies.
With conservative reservations, a run may exhaust a token limit before its request-count limit.

Before upstream admission the gateway atomically reserves the full model context plus maximum
output, bounds the wire envelope, and fixes model/output/sampling settings. It uses no optimistic
bytes/4 estimate. Invalid routes and exhausted budgets never reach upstream. Failed, cancelled,
retry and child/helper/summary/learning requests count; missing final usage retains reservations.
Cache/reasoning subsets are not added again to totals. An observed reservation overrun poisons
further admission. Concurrency bounds in-flight exposure. Cancelling a remote request does not
prove that remote billing stopped. Provider credentials, when needed, live only in the gateway.
The controller revokes a trial's capability on cancellation and after artifact observation;
this is recorded separately from the application's Stop and never earns product-safety credit.

## Analysis and remaining qualification

Descriptive acceptance denominators include every planned trial. All attempted resource costs
contribute to cost per accepted task, which is null when no task is accepted. Fixed-seed clustered
bootstrap intervals resample templates/trajectories as clusters. W0-8's compatible paired p50/p95
engine is reused; versus-specific quality differences and resource-per-acceptance ratios use
24,000 resamples and Bonferroni adjustment across four claims and seven quality guards.
The C20 bar requires all 24 tasks with at least 20 pairs each and all six department guards.
Missing prices, zero baselines, insufficient clusters or incomplete comparisons remain
inconclusive. No global superiority headline is produced. T0 results are always ineligible.

Resource helpers name RSS accounting, reject duplicate process rows, account for the shared
model separately and avoid summing host VM plus guest memory as independent physical RAM.
Physical memory, full packaged-stack coverage and joules remain unmeasured. Battery percentage
is never energy. H01–H12 product outcomes, ten-boundary recovery qualification, human adjudication,
novice onboarding, native routes and real child/learning trajectories remain explicit gaps.

The real-stack integration must pass the landed tape, including its current tool catalog.
Compatibility failures are retained and fail qualification. A newly recorded T0 tape is also
tested through strict replay with a fresh database; it does not replace the landed fixture or
become reasoning evidence. Inspect the RPC report for separate ordinary-run, landed/fresh replay,
MCP, approval, cancellation and recovery outcomes, including persisted replies and failures.

## Validation

```sh
pnpm --filter @ardurbot/testkit check
pnpm exec biome check packages/testkit/src/versus packages/testkit/src/scoreboard/replay/production.ts packages/testkit/src/scoreboard/replay/postgres.ts
pnpm exec vitest run packages/testkit/src/versus packages/testkit/src/performance-report.test.ts packages/testkit/src/scoreboard/manifest.test.ts packages/testkit/src/scoreboard/statistics.test.ts packages/testkit/src/scoreboard/tasks/contracts.test.ts packages/testkit/src/scoreboard/replay/protocol.test.ts packages/testkit/src/scoreboard/replay/evidence.test.ts packages/testkit/src/scoreboard/replay/services.test.ts packages/testkit/src/scoreboard/replay/native.test.ts packages/testkit/src/scoreboard/replay/live.test.ts
```

No desktop E2E, live provider, Hermes invocation or model download is needed for this validation.
Prime Agent and direct Claude Code/Codex remain extension adapters; no installation is required.
