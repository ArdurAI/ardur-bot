import { createHash } from "node:crypto";

export type EvidenceTier = "T0" | "T1" | "T2" | "T3";
export type MetricUnit =
  | "ms"
  | "tokens"
  | "count"
  | "ratio"
  | "bytes"
  | "joules"
  | "watts"
  | "per-second";
export type MetricDirection = "lower" | "higher" | "diagnostic";
export interface MetricDefinition {
  id: string;
  familyId: string;
  name: string;
  unit: MetricUnit;
  direction: MetricDirection;
  minimum: number;
  maximum: number | null;
  requiredCoverage: number;
  statistics: readonly string[];
}

function family(
  id: string,
  name: string,
  definition: string,
  provenance: string,
  groups: readonly (readonly [MetricUnit, MetricDirection, string])[],
) {
  return {
    id,
    name,
    definition,
    provenance,
    metrics: groups.flatMap(([unit, direction, names]) =>
      names.split(" ").map(
        (metric): MetricDefinition => ({
          id: `${id}.${metric}`,
          familyId: id,
          name: metric,
          unit,
          direction,
          minimum: 0,
          maximum: unit === "ratio" ? 1 : null,
          requiredCoverage: 1,
          statistics:
            unit === "ms"
              ? ["p50", "p95", "sample-count", "confidence-interval"]
              : ["raw", "sample-count"],
        }),
      ),
    ),
  };
}

// Definitions are a frozen protocol, not results or calibrated performance gates.
export const METRIC_FAMILIES = freeze([
  family(
    "m01",
    "User TTFT",
    "Submission to painted non-placeholder content; useful activity is separate.",
    "Client trace with calibrated process boundaries.",
    [
      [
        "ms",
        "lower",
        "user-ttft first-transport first-text first-safe-content first-paint useful-activity acknowledgement safe-to-paint",
      ],
    ],
  ),
  family(
    "m02",
    "Provider TTFT",
    "Per attempt request start to content; distinguish setup, protocol and reasoning.",
    "Provider request trace; native internal spans can be unavailable.",
    [
      [
        "ms",
        "lower",
        "provider-ttft connection-setup first-protocol reasoning-activity visible-content",
      ],
    ],
  ),
  family(
    "m03",
    "End-to-end turn time",
    "Submission to durable terminal state and terminal paint, stratified by every outcome.",
    "Client and durable terminal trace; retain failed, cancelled, timed-out and uncertain trials.",
    [
      ["ms", "lower", "durable-terminal terminal-paint"],
      ["ratio", "higher", "success-within-deadline"],
    ],
  ),
  family(
    "m04",
    "Prompt tokens per turn",
    "Attribute main, retry, helper, summary and delegated requests once; detached learning is separate.",
    "Per-request usage with route normalization and counter provenance; estimates are labeled.",
    [
      [
        "tokens",
        "lower",
        "logical-input uncached-input output reasoning detached-learning-input detached-learning-output",
      ],
      ["tokens", "diagnostic", "cache-read-input cache-write-input"],
    ],
  ),
  family(
    "m05",
    "Cache hit ratio",
    "Cached input divided by logical input plus request hit rate; separate all reuse mechanisms.",
    "Live provider usage establishes cache hits; replay establishes accounting and prefix eligibility only.",
    [
      ["ratio", "higher", "cache-token-hit cache-request-hit prefix-eligibility"],
      ["count", "diagnostic", "application-result-reuse native-session-reuse"],
    ],
  ),
  family(
    "m06",
    "Compaction count and quality",
    "Attempts, costs and quality are separate for runtime-owned and application-owned compaction.",
    "Compaction trace, request ledger and downstream probes; include stale and failed attempts.",
    [
      ["count", "diagnostic", "attempts successes failures stale-commits-rejected"],
      [
        "tokens",
        "diagnostic",
        "before-tokens after-tokens summary-input summary-output request-input",
      ],
      ["ms", "lower", "elapsed"],
      ["ratio", "higher", "recall task-success"],
    ],
  ),
  family(
    "m07",
    "Tool latency",
    "Selection to result with component spans; retain total time and report human waiting separately.",
    "Tool trace linked to permission, computer, execution, durable-write and render boundaries.",
    [
      [
        "ms",
        "lower",
        "selection-to-result queue-wait permission-wait computer-readiness connection-setup execution durable-result-write render",
      ],
    ],
  ),
  family(
    "m08",
    "Queue wait",
    "First eligible time to lease acquisition including capacity wait; schedule and rate limits separate.",
    "Durable admission and lease trace with job class, offered load and fixed resources.",
    [
      ["ms", "lower", "eligible-to-lease schedule-delay rate-limit-wait oldest-job-age"],
      ["count", "diagnostic", "concurrency"],
      ["per-second", "diagnostic", "offered-load completed-throughput"],
      ["ratio", "lower", "failure-rate"],
    ],
  ),
  family(
    "m09",
    "Desktop cold start",
    "Launch to window, usable authenticated shell, restored transcript and working submission.",
    "Packaged process and paint trace stratified by process, Chromium, install, stack and reboot state.",
    [["ms", "lower", "first-window usable-shell restored-transcript working-turn"]],
  ),
  family(
    "m10",
    "Idle and peak memory",
    "Per-process and whole-machine incremental footprint; never sum guest and host twice.",
    "Declare RSS, private bytes, PSS or working set accounting; include the container VM and local models.",
    [["bytes", "lower", "idle-footprint peak-footprint high-water post-idle-retained"]],
  ),
  family(
    "m11",
    "Bundle and installer size",
    "Initial and deferred assets, complete packages and installed footprint per target.",
    "Production artifact checksums and static dependency graph; preserve protected lazy boundaries.",
    [
      [
        "bytes",
        "lower",
        "initial-js-raw initial-js-gzip initial-js-brotli css fonts renderer-assets main preload host asar native-modules installer download installed",
      ],
      ["count", "lower", "lazy-boundary-violations"],
    ],
  ),
  family(
    "m12",
    "Fixed-task success",
    "Grader outcome, critical constraints, deadline and repeated consistency per task and department.",
    "Hidden deterministic graders; replay delivery and live quality are distinct; human judgment separate.",
    [["ratio", "higher", "outcome-pass critical-constraints deadline-pass repeated-consistency"]],
  ),
  family(
    "m13",
    "Reliability",
    "Retain effects, uncertainty, retries and replayed work; safe uncertainty is not task completion.",
    "Durable fault traces and independent state/effect checks at every named crash boundary.",
    [
      [
        "count",
        "lower",
        "duplicate-effects lost-accepted-work wrong-pin unauthorized-effects false-completion uncertain-outcomes retries replayed-work",
      ],
      ["ratio", "higher", "crash-free-sessions"],
      ["ms", "lower", "recovery cancellation-acknowledgement terminal-stop"],
      ["tokens", "lower", "wasted-tokens"],
    ],
  ),
  family(
    "m14",
    "Battery and responsiveness",
    "Direct energy and idle power, CPU time, wakeups, stalls and long frames; CPU is not energy.",
    "Physical energy instrument with matched idle controls; platform process and UI traces.",
    [
      ["ms", "lower", "idle-cpu-time event-loop-stall long-frame"],
      ["count", "lower", "wakeups"],
      ["joules", "lower", "task-energy"],
      ["watts", "lower", "idle-power"],
    ],
  ),
]);

export const METRIC_DEFINITIONS = freeze(METRIC_FAMILIES.flatMap((item) => item.metrics));

const taskRows = [
  ["customer-operations", "Policy lookup", "Correct policy revision and citations"],
  ["customer-operations", "Case timeline", "Ordered events"],
  ["customer-operations", "Entitlement reconciliation", "Exact reconciliation set"],
  ["customer-operations", "Approved case update", "One authorized update"],
  ["sales", "Account brief", "Required sourced facts"],
  ["sales", "Duplicate-record detection", "Correct duplicate IDs"],
  ["sales", "Quote calculation", "Exact arithmetic"],
  ["sales", "Draft follow-up", "Draft retained without unsolicited sending"],
  ["finance", "Invoice matching", "Exact matched and unmatched sets"],
  ["finance", "Expense-policy check", "Correct policy exception"],
  ["finance", "CSV variance report", "Correct totals"],
  ["finance", "Approval routing", "Proper pending and approved state"],
  ["people-operations", "Onboarding checklist", "Complete required steps"],
  ["people-operations", "Leave-policy answer", "Correct scoped policy"],
  ["people-operations", "Training-record reconciliation", "Exact missing records"],
  [
    "people-operations",
    "Meeting conflict resolution",
    "Consistent schedule with consent boundaries",
  ],
  ["research-management", "Multi-document brief", "Evidence coverage"],
  ["research-management", "Conflicting-source analysis", "Unresolved conflicts preserved"],
  ["research-management", "Chart extraction", "Exact chart values"],
  ["research-management", "Delegated group brief", "Accepted child results and provenance"],
  ["engineering-it", "Small repository repair", "Hidden tests"],
  ["engineering-it", "Shell diagnosis", "Accurate causal evidence"],
  ["engineering-it", "Configuration comparison", "Exact scoped diff"],
  ["engineering-it", "Interrupted workspace task", "Correct recovery and no duplicate side effect"],
] as const;

export const TASK_DEFINITIONS = freeze(
  taskRows.map(([department, name, objective], index) => ({
    id: `task-${String(index + 1).padStart(2, "0")}`,
    department,
    name,
    objective,
    fixtureContract: [
      "input-files",
      "initial-database-state",
      "allowed-tools",
      "expected-state-changes",
      "required-evidence",
      "hidden-grader",
    ],
    variants: ["short-history", "long-history", "local-tools", "remote-tools-where-supported"],
    implementation: "not-implemented",
  })),
);

function experiment(
  id: string,
  name: string,
  tiers: EvidenceTier[],
  variants: string[],
  guardrails: string[],
  conditionalVariants: string[] = [],
) {
  return {
    id,
    name,
    tiers,
    variants,
    guardrails,
    conditionalVariants,
    implementation: "not-implemented",
  };
}

export const EXPERIMENT_DEFINITIONS = freeze([
  experiment(
    "O1",
    "Evidence and comparator validity",
    ["T0"],
    [
      "missing-keys",
      "extra-keys",
      "zero-counts",
      "negative-durations",
      "nonfinite-values",
      "reversed-directions",
      "wrong-units",
      "environment-mismatch",
      "dirty-builds",
      "schema-migrations",
    ],
    ["distinct-warning-failure-incomplete", "immutable-index"],
  ),
  experiment(
    "O2",
    "Streaming boundaries",
    ["T1", "T2"],
    [
      "one-byte",
      "burst",
      "long-gap",
      "split-unicode",
      "split-secret",
      "short-final-delta",
      "slow-database",
      "slow-renderer",
    ],
    [
      "exact-ordered-output",
      "no-secret-exposure",
      "bounded-queue-bytes",
      "safe-to-paint",
      "finite-cancellation",
    ],
  ),
  experiment(
    "O3",
    "Prefix and cache accounting",
    ["T1", "T3"],
    ["unchanged", "time-only", "memory-revision", "grant-change", "tool-schema"],
    [
      "prefix-hashes",
      "provider-boundaries",
      "normalized-usage",
      "live-telemetry-only-for-cache-claims",
    ],
  ),
  experiment(
    "O4",
    "Compaction quality and races",
    ["T1", "T3"],
    [
      "full-history",
      "compacted",
      "summary-timeout",
      "summary-truncation",
      "concurrent-history-edit",
    ],
    [
      "critical-facts",
      "negations",
      "superseded-decisions",
      "pending-approvals",
      "unresolved-actions",
      "source-references",
      "no-unverified-replacement",
      "no-stale-commit",
    ],
  ),
  experiment(
    "O5",
    "Memory store scaling",
    ["T1"],
    ["documents-100", "documents-1000", "documents-10000", "revisions-1", "revisions-20"],
    [
      "cross-product-fixed-sizes-scopes",
      "query-count",
      "rows-bytes",
      "query-plans",
      "locks",
      "p95",
      "peak-heap",
      "store-conformance",
    ],
  ),
  experiment(
    "O6",
    "Connector catalog invalidation",
    ["T1"],
    [
      "connectors-0",
      "connectors-10",
      "connectors-50",
      "fast",
      "slow",
      "paginated",
      "unavailable",
      "changing-catalog",
      "grant-change",
      "schema-change",
    ],
    ["first-cached-discovery", "live-authority", "required-optional-failure"],
  ),
  experiment(
    "O7",
    "Mixed-load admission",
    ["T1"],
    [
      "demand-1",
      "demand-4",
      "demand-16",
      "open-loop",
      "fixed-concurrency",
      "learning-burst",
      "memory-delivery-burst",
      "delegation-burst",
      "parent-slots-full",
    ],
    [
      "fixed-resource-limits",
      "user-wait",
      "maintenance-completion",
      "fairness",
      "oldest-job",
      "callback-progress",
      "offered-completed-failed-load",
    ],
  ),
  experiment(
    "O8",
    "Shared-account retry policy",
    ["T1"],
    [
      "429-reset",
      "retry-after-zero",
      "retry-after-malformed",
      "5xx",
      "disconnect",
      "authentication-failure",
      "quota-exhaustion",
    ],
    ["one-admission-policy", "bounded-attempts", "seeded-jitter", "cancellation", "same-provider"],
  ),
  experiment(
    "O9",
    "Durable crash recovery",
    ["T1"],
    ["worker-kill", "api-kill", "host-kill", "reconnect", "restart", "retry-same-request"],
    [
      "real-postgresql-queue",
      "all-ten-boundaries",
      "fencing",
      "intent-result-consistency",
      "valid-recovery",
      "explicit-uncertainty",
      "no-repeated-action",
    ],
  ),
  experiment(
    "O10",
    "Native session lifecycle",
    ["T1", "T3"],
    [
      "new-turn",
      "resumed-turn",
      "pin-change",
      "instruction-change",
      "grant-change",
      "cli-restart",
      "login-revoked",
      "protocol-version-change",
    ],
    [
      "process-count",
      "setup-spans",
      "retained-memory",
      "leak-slope",
      "real-cli-smoke-before-support",
    ],
  ),
  experiment(
    "O11",
    "Computer lifecycle",
    ["T1", "T2"],
    ["image-absent", "container-cold", "warm-reuse", "stopped-workspace", "checkpointed-workspace"],
    [
      "filesystem-state",
      "scope",
      "startup",
      "background-job-safety",
      "idle-cost",
      "disk-growth",
      "bounded-eviction",
    ],
    ["checkpointed-workspace"],
  ),
  experiment(
    "O12",
    "Packaged startup and resources",
    ["T2"],
    [
      "process-cold-os-warm",
      "chromium-cache-cold",
      "fresh-install",
      "local-stack-cold",
      "reboot-cold",
      "warm",
      "fixed-transcript",
      "stream",
      "hide-reopen",
      "lock-unlock",
      "suspend-resume",
      "idle-15m",
      "quiet-30m",
      "soak-2h",
    ],
    ["matched-hardware", "first-interaction", "whole-stack-memory", "wakeups", "direct-power"],
  ),
  experiment(
    "O13",
    "Snapshot initialization",
    ["T1", "T2"],
    [
      "normal-start",
      "snapshot-start",
      "invalid-snapshot",
      "stale-snapshot",
      "open-handles",
      "process-state",
    ],
    [
      "identical-binary-runtime-platform",
      "normal-start-fallback",
      "snapshot-size",
      "generation-time",
      "restoration-failures",
      "first-task-correctness",
    ],
    ["snapshot-start", "invalid-snapshot", "stale-snapshot", "open-handles", "process-state"],
  ),
]);

export const CRASH_BOUNDARIES = freeze([
  { id: "crash-01", name: "Admission committed before enqueue", expected: "automatic-recovery" },
  { id: "crash-02", name: "Lease acquired before work", expected: "safe-retry" },
  { id: "crash-03", name: "Intent persisted before action", expected: "safe-retry" },
  {
    id: "crash-04",
    name: "External action completed before receipt",
    expected: "explicit-uncertainty",
  },
  {
    id: "crash-05",
    name: "Result persisted before terminal state",
    expected: "automatic-recovery",
  },
  {
    id: "crash-06",
    name: "Terminal state committed before UI delivery",
    expected: "automatic-recovery",
  },
  { id: "crash-07", name: "Pending approval", expected: "automatic-recovery" },
  { id: "crash-08", name: "Compaction commit", expected: "safe-retry" },
  { id: "crash-09", name: "Memory delivery", expected: "safe-retry" },
  { id: "crash-10", name: "Native host disconnect", expected: "explicit-uncertainty" },
]);

export const SCOREBOARD_MANIFEST = freeze({
  schemaVersion: 1,
  suiteVersion: "scoreboard-1",
  families: METRIC_FAMILIES,
  tasks: TASK_DEFINITIONS,
  experiments: EXPERIMENT_DEFINITIONS,
  crashBoundaries: CRASH_BOUNDARIES,
  tiers: {
    T0: "Deterministic contracts; virtual time is not performance.",
    T1: "Production-path replay with real API, PostgreSQL, worker, executor, parsers and transports; offline after provisioning.",
    T2: "Packaged production clients and real local stack on isolated fixed hardware; web and mobile are separate strata.",
    T3: "Explicitly selected budgeted live routes and unmodified CLIs; required for live-dependent claims.",
  },
  samplePlan: {
    commitPairs: 20,
    releaseReplayPairs: 200,
    releaseStartupObservationsPerStratum: 100,
    stabilizedIdleMinutes: 15,
    quietIntervalMinutes: 30,
    mixedSoakMinutes: 120,
    contextCapacities: [16_000, 128_000, 1_000_000],
    timingModes: ["zero-service-delay", "fixed-delay", "live", "virtual"],
    comparisonModes: ["controlled-harness", "product-outcome"],
    baselines: ["parent", "fixed-release"],
    pairing:
      "Alternate or randomize on the same runner with identical resets, power mode and resource limits.",
    analysis:
      "Predeclare seed, independent run/session bootstrap, critical families and multiple-comparison adjustment; preserve failures and valid slow trials.",
    taskEdges: [
      "above-message-threshold",
      "oversized-single-message",
      "wide-tool-schema",
      "attachments",
      "stale-memory",
      "policy-change-during-run",
    ],
  },
  proposedGates: {
    status: "uncalibrated",
    development: "advisory",
    release: "Required comparable complete evidence and separate human acceptance.",
    criticalSafety: [
      "wrong-pin",
      "unauthorized-effect",
      "duplicate-effect",
      "lost-accepted-work",
      "false-completion",
      "invalid-recovery",
      "critical-compaction-fact-loss",
    ],
    latency: {
      warningRelative: 0.05,
      warningAbsoluteMs: 25,
      releaseRelative: 0.1,
      releaseAbsoluteMs: 25,
      combination: "max",
      statistic: "family-adjusted-upper-confidence-bound",
    },
    absoluteP95Ms: {
      acknowledgement: 100,
      safeToPaint: 50,
      nominalQueue: 250,
      stopAcknowledgement: 1000,
    },
    promptTokens: { relative: 0.05, absolute: 128, combination: "max" },
    warmCacheDropPoints: 5,
    initialGzipGrowthBytes: 10_240,
    totalArtifactGrowth: 0.05,
    idleMemory: { relative: 0.1, absoluteBytes: 32 * 1024 * 1024, combination: "max" },
    peakMemory: { relative: 0.15, absoluteBytes: 64 * 1024 * 1024, combination: "max" },
    energyGrowth: 0.1,
    statisticalVerdicts: ["improved", "within-budget", "regressed", "inconclusive"],
    incomplete:
      "Unknown, unimplemented or incompatible required evidence cannot pass; overlapping regression bounds are inconclusive.",
  },
});

export type ScoreboardManifest = typeof SCOREBOARD_MANIFEST;
export interface ManifestEnvelope {
  sha256: string;
  manifest: ScoreboardManifest;
}

// Canonical JSON v1: sorted object keys, ordered arrays, finite JSON primitives only.
// Reject lossy values rather than letting JSON.stringify silently omit or coerce them.
export function canonicalSerialize(value: unknown): string {
  const active = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || active.has(item))
      throw new Error("Expected acyclic finite JSON");
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new Error("Expected plain JSON object");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Symbol keys are not JSON");
    active.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.getOwnPropertyNames(item).length !== item.length + 1)
        throw new Error("Sparse or extended arrays are not JSON");
      result = `[${Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw new Error("Sparse arrays and JSON accessors are not supported");
        return encode(descriptor.value);
      }).join(",")}]`;
    } else {
      if (Object.getOwnPropertyNames(item).length !== Object.keys(item).length)
        throw new Error("Non-enumerable properties are not JSON");
      result = `{${Object.keys(item)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!("value" in descriptor)) throw new Error("JSON accessors are not supported");
          return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
        })
        .join(",")}}`;
    }
    active.delete(item);
    return result;
  }
  return encode(value);
}

export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}

export function createScoreboardManifest(): ManifestEnvelope {
  return { sha256: contentDigest(SCOREBOARD_MANIFEST), manifest: SCOREBOARD_MANIFEST };
}

export function parseScoreboardManifest(value: unknown): ManifestEnvelope {
  // Detach caller-owned state before checking it, including mutations between consumers.
  const copy = JSON.parse(canonicalSerialize(value)) as ManifestEnvelope;
  if (
    !copy ||
    typeof copy !== "object" ||
    Object.keys(copy).length !== 2 ||
    Object.keys(copy).sort().join(",") !== "manifest,sha256"
  )
    throw new Error("Invalid manifest envelope");
  if (copy.sha256 !== contentDigest(copy.manifest)) throw new Error("Manifest checksum mismatch");
  if (canonicalSerialize(copy.manifest) !== canonicalSerialize(SCOREBOARD_MANIFEST))
    throw new Error(
      "Unsupported or incomplete scoreboard manifest; version definitions explicitly",
    );
  return freeze(copy);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
