import type { EvidenceTier, MetricDirection, MetricUnit } from "./scoreboard/manifest.js";
import {
  CRASH_BOUNDARIES,
  canonicalSerialize,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  SCOREBOARD_MANIFEST,
  TASK_DEFINITIONS,
} from "./scoreboard/manifest.js";

export interface NumericSummary {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

export const PERFORMANCE_REPORT_SCHEMA_VERSION = 2 as const;

export interface PerformanceReport {
  schemaVersion: typeof PERFORMANCE_REPORT_SCHEMA_VERSION;
  label: string;
  createdAt: string;
  environment: {
    gitSha: string;
    gitDirty: boolean;
    platform: string;
    release: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
    node: string;
    electron?: string;
    chrome?: string;
    playwright: string;
    buildMode: string;
    rendererMode: string;
    warmWindow: string;
    assetDelayMs?: number;
  };
  fixture: {
    backend: string;
    messageCount: number;
    webOrigin: string;
    launchSamples: number;
    cacheColdDefinition: string;
    warmDefinition: string;
  };
  launches: { cacheCold: unknown[]; warm: unknown[] };
  interactions: unknown;
  bundles: {
    web: BundleSize;
    desktop: BundleSize | null;
  };
  summary: {
    cacheColdShellUsableMs: NumericSummary;
    warmShellUsableMs: NumericSummary;
    settingsPaintedMs: number;
    settingsSettledMs: number;
    typingKeyPaintMs: NumericSummary;
    idleCpuPercent: NumericSummary;
    idleSummedWorkingSetKiB: NumericSummary;
    streamingCpuPercent: NumericSummary;
    reopenMs: number | null;
    hiddenSummedWorkingSetKiB: number | null;
  };
}

export interface BundleSize {
  fileCount: number;
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

export function summarize(values: number[]): NumericSummary {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0]!,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)!,
  };
}

export function percentageDelta(before: number, after: number) {
  if (before === 0) return after === 0 ? 0 : null;
  return ((after - before) / before) * 100;
}

export function roundMetric(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

export function parsePerformanceReport(value: unknown, source: string): PerformanceReport {
  if (!isRecord(value)) throw invalidReport(source, "expected a JSON object");
  if (value.schemaVersion !== 1 && value.schemaVersion !== PERFORMANCE_REPORT_SCHEMA_VERSION) {
    throw invalidReport(
      source,
      `unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} (supported: 1, ${PERFORMANCE_REPORT_SCHEMA_VERSION})`,
    );
  }
  if (typeof value.label !== "string") throw invalidReport(source, "label must be a string");
  if (!isRecord(value.environment)) {
    throw invalidReport(source, "environment must be an object");
  }
  if (!isRecord(value.summary)) throw invalidReport(source, "summary must be an object");

  const normalized =
    value.schemaVersion === 1
      ? migrateSchemaOne(value, source)
      : ({ ...value, schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION } as Record<string, unknown>);
  assertSummary(normalized.summary, source);
  return normalized as unknown as PerformanceReport;
}

export function parseTcpPort(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      `${name} must be an integer between 1 and 65535; received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function migrateSchemaOne(value: Record<string, unknown>, source: string) {
  const summary = value.summary;
  if (!isRecord(summary)) throw invalidReport(source, "summary must be an object");
  if (!("idleSummedPrivateKiB" in summary)) {
    throw invalidReport(source, "summary.idleSummedPrivateKiB is missing from schema 1 report");
  }
  return {
    ...value,
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    summary: {
      ...summary,
      idleSummedWorkingSetKiB: summary.idleSummedPrivateKiB,
      reopenMs: summary.reopenMs ?? null,
      hiddenSummedWorkingSetKiB: summary.hiddenSummedPrivateKiB ?? null,
    },
  };
}

function assertSummary(
  value: unknown,
  source: string,
): asserts value is PerformanceReport["summary"] {
  if (!isRecord(value)) throw invalidReport(source, "summary must be an object");
  for (const key of [
    "cacheColdShellUsableMs",
    "warmShellUsableMs",
    "typingKeyPaintMs",
    "idleCpuPercent",
    "idleSummedWorkingSetKiB",
    "streamingCpuPercent",
  ] as const) {
    if (!isNumericSummary(value[key])) {
      throw invalidReport(source, `summary.${key} must be a numeric summary`);
    }
  }
  for (const key of ["settingsPaintedMs", "settingsSettledMs"] as const) {
    if (!isFiniteNumber(value[key])) {
      throw invalidReport(source, `summary.${key} must be a finite number`);
    }
  }
  for (const key of ["reopenMs", "hiddenSummedWorkingSetKiB"] as const) {
    if (value[key] !== null && !isFiniteNumber(value[key])) {
      throw invalidReport(source, `summary.${key} must be a finite number or null`);
    }
  }
}

function isNumericSummary(value: unknown): value is NumericSummary {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.count) &&
    (value.count as number) > 0 &&
    isFiniteNumber(value.min) &&
    isFiniteNumber(value.median) &&
    isFiniteNumber(value.p95) &&
    isFiniteNumber(value.max)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidReport(source: string, detail: string) {
  return new Error(`Invalid performance report ${source}: ${detail}`);
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** Schema 2 remains the desktop writer contract. Schema 3 is opt-in evidence. */
export const PERFORMANCE_EVIDENCE_SCHEMA_VERSION = 3 as const;
export const MISSING_REASONS = [
  "not-measured",
  "unsupported",
  "not-applicable",
  "feature-not-implemented",
  "provider-omitted",
  "failed-before-usage",
  "cancelled-before-usage",
  "infrastructure-unavailable",
  "invalid-trial",
  "missing-revoke-control",
  "missing-pin-control",
  "missing-revoke-and-pin-controls",
  "redacted",
  "unknown",
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];
export type EvidenceOutcome = "success" | "failed" | "cancelled" | "timed-out" | "uncertain";
export type EvidenceProvenance =
  | "measured"
  | "provider-live"
  | "recorded-provider"
  | "counted"
  | "estimated"
  | "virtual";
export interface EvidenceValue {
  value: number | null;
  missingReason: MissingReason | null;
  provenance: { kind: EvidenceProvenance; sourceHash: string } | null;
}
export interface MetricObservation extends EvidenceValue {
  id: string;
  sessionId: string;
  pairId: string | null;
  traceId: string;
  outcome: EvidenceOutcome;
}
export interface MetricEvidence {
  id: string;
  unit: MetricUnit;
  direction: MetricDirection;
  applicability: "applicable" | "not-applicable";
  missingReason: MissingReason | null;
  coverage: { expected: number; observed: number };
  observations: MetricObservation[];
}
export const USAGE_CATEGORIES = [
  "logicalInput",
  "uncachedInput",
  "cacheReadInput",
  "cacheWriteInput",
  "output",
  "reasoning",
] as const;
export interface RequestUsageEvidence {
  requestId: string;
  turnId: string;
  attemptId: string;
  parentRequestId: string | null;
  purpose: "main" | "retry" | "helper" | "summary" | "delegated" | "detached-learning";
  routeId: string;
  traceId: string;
  outcome: EvidenceOutcome;
  // Describes the provider's input field. Normalized categories are disjoint in either case:
  // logicalInput = uncachedInput + cacheReadInput + cacheWriteInput when all are supplied.
  inputSemantics: "total-with-cache-subsets" | "additive-cache-categories" | "unknown";
  // A reasoning subset is already included in output; a separate category is additive.
  reasoningSemantics: "subset-of-output" | "separate" | "unknown";
  requestHash: string;
  usageRequestHash: string;
  // Values are request deltas, never running totals. Epoch changes identify counter resets.
  counter: { mode: "request-delta" | "cumulative-difference"; epochId: string; sequence: number };
  categories: Record<(typeof USAGE_CATEGORIES)[number], EvidenceValue>;
}
export interface TaskEvidence {
  id: string;
  status: "complete" | "incomplete" | "feature-not-implemented";
  missingReason: MissingReason | null;
  fixtureHash: string | null;
  graderHash: string | null;
  trials: {
    id: string;
    sessionId: string;
    pairId: string | null;
    traceId: string;
    outcome: EvidenceOutcome;
    passed: boolean;
    criticalPassed: boolean;
    withinDeadline: boolean;
  }[];
}
export interface ExperimentEvidence {
  id: string;
  variants: {
    id: string;
    status: "complete" | "incomplete" | "feature-not-implemented";
    missingReason: MissingReason | null;
    traceIds: string[];
  }[];
}
export interface CrashEvidence {
  id: string;
  status: "complete" | "incomplete" | "feature-not-implemented";
  missingReason: MissingReason | null;
  recovery: "automatic-recovery" | "safe-retry" | "explicit-uncertainty" | null;
  safetyPassed: boolean | null;
  taskCompleted: boolean | null;
  traceIds: string[];
}
export interface PerformanceEvidenceReport {
  schemaVersion: typeof PERFORMANCE_EVIDENCE_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  manifestHash: string;
  build: {
    commit: string;
    parentCommit: string;
    fixedReleaseCommit: string;
    dirty: boolean;
    diffDigest: string | null;
    artifactHash: string;
  };
  hashes: { benchmark: string; fixture: string; grader: string; dependencyLock: string };
  environment: {
    platform: string;
    arch: string;
    hardwareClass: string;
    osVersion: string;
    runtimeVersions: { id: string; version: string }[];
    containerDigests: string[];
    buildMode: string;
    powerMode: string;
    thermalState: string;
    backgroundLoad: string;
    memoryAccounting: "rss" | "private-bytes" | "pss" | "working-set" | "not-measured";
    resourceLimitsHash: string;
    sampleIntervalMs: number | null;
  };
  environmentHash: string;
  scenario: {
    id: string;
    tier: EvidenceTier;
    comparisonMode: "controlled-harness" | "product-outcome";
    timingMode: "zero-service-delay" | "fixed-delay" | "live" | "virtual";
    cacheState: string;
    loadScheduleHash: string;
    routeHash: string;
    deadlineMs: number;
  };
  artifacts: {
    sha256: string;
    bytes: number;
    kind: "trace" | "raw" | "fixture" | "grader" | "build";
  }[];
  traces: {
    id: string;
    artifactHash: string;
    clock: "monotonic" | "calibrated" | "request-boundary" | "virtual";
  }[];
  metrics: MetricEvidence[];
  tasks: TaskEvidence[];
  experiments: ExperimentEvidence[];
  crashes: CrashEvidence[];
  usageCoverage: { expected: number; observed: number };
  usage: RequestUsageEvidence[];
}

/** Read every generation without upgrading legacy summaries into invented evidence. */
export function readPerformanceReport(
  value: unknown,
  source: string,
): PerformanceReport | PerformanceEvidenceReport {
  if (isRecord(value) && value.schemaVersion === PERFORMANCE_EVIDENCE_SCHEMA_VERSION)
    return parsePerformanceEvidenceReport(value, source);
  return parsePerformanceReport(value, source);
}

/** Parse incomplete reports too; assertRequiredEvidence enforces a trusted selection. */
export function parsePerformanceEvidenceReport(
  value: unknown,
  source: string,
): PerformanceEvidenceReport {
  try {
    // A JSON snapshot prevents caller mutation from invalidating already checked references.
    const report = JSON.parse(canonicalSerialize(value)) as PerformanceEvidenceReport;
    keys(report, [
      "schemaVersion",
      "id",
      "createdAt",
      "manifestHash",
      "build",
      "hashes",
      "environment",
      "environmentHash",
      "scenario",
      "artifacts",
      "traces",
      "metrics",
      "tasks",
      "experiments",
      "crashes",
      "usageCoverage",
      "usage",
    ]);
    check(report.schemaVersion === 3, "unsupported evidence schemaVersion");
    opaque(report.id);
    check(
      typeof report.createdAt === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(report.createdAt) &&
        new Date(report.createdAt).toISOString() === report.createdAt,
      "invalid createdAt",
    );
    check(report.manifestHash === contentDigest(SCOREBOARD_MANIFEST), "incompatible manifestHash");
    keys(report.build, [
      "commit",
      "parentCommit",
      "fixedReleaseCommit",
      "dirty",
      "diffDigest",
      "artifactHash",
    ]);
    for (const key of ["commit", "parentCommit", "fixedReleaseCommit"] as const)
      check(
        typeof report.build[key] === "string" && /^[a-f0-9]{40}$/.test(report.build[key]),
        "invalid commit hash",
      );
    check(typeof report.build.dirty === "boolean", "invalid dirty flag");
    if (report.build.dirty) digest(report.build.diffDigest);
    else check(report.build.diffDigest === null, "clean build cannot carry a diff digest");
    digest(report.build.artifactHash);
    keys(report.hashes, ["benchmark", "fixture", "grader", "dependencyLock"]);
    for (const hash of Object.values(report.hashes)) digest(hash);
    const env = report.environment;
    keys(env, [
      "platform",
      "arch",
      "hardwareClass",
      "osVersion",
      "runtimeVersions",
      "containerDigests",
      "buildMode",
      "powerMode",
      "thermalState",
      "backgroundLoad",
      "memoryAccounting",
      "resourceLimitsHash",
      "sampleIntervalMs",
    ]);
    for (const key of [
      "platform",
      "arch",
      "hardwareClass",
      "osVersion",
      "buildMode",
      "powerMode",
      "thermalState",
      "backgroundLoad",
    ] as const)
      opaque(env[key]);
    unique(
      array(env.runtimeVersions).map((runtime) => {
        keys(runtime, ["id", "version"]);
        opaque(runtime.id);
        opaque(runtime.version);
        return runtime.id;
      }),
    );
    check(env.runtimeVersions.length > 0, "runtime versions required");
    unique(array(env.containerDigests));
    for (const hash of env.containerDigests) digest(hash);
    oneOf(env.memoryAccounting, ["rss", "private-bytes", "pss", "working-set", "not-measured"]);
    digest(env.resourceLimitsHash);
    if (env.sampleIntervalMs !== null) positive(env.sampleIntervalMs);
    check(report.environmentHash === contentDigest(env), "environment checksum mismatch");
    keys(report.scenario, [
      "id",
      "tier",
      "comparisonMode",
      "timingMode",
      "cacheState",
      "loadScheduleHash",
      "routeHash",
      "deadlineMs",
    ]);
    opaque(report.scenario.id);
    opaque(report.scenario.cacheState);
    oneOf(report.scenario.tier, ["T0", "T1", "T2", "T3"]);
    oneOf(report.scenario.comparisonMode, ["controlled-harness", "product-outcome"]);
    oneOf(report.scenario.timingMode, ["zero-service-delay", "fixed-delay", "live", "virtual"]);
    check(
      (report.scenario.tier === "T0") === (report.scenario.timingMode === "virtual"),
      "virtual timing belongs only to T0",
    );
    if (report.scenario.tier === "T3")
      check(report.scenario.timingMode === "live", "T3 requires live timing");
    if (report.scenario.tier === "T1")
      check(report.scenario.timingMode !== "live", "T1 is replay, not live");
    digest(report.scenario.loadScheduleHash);
    digest(report.scenario.routeHash);
    positive(report.scenario.deadlineMs);
    unique(
      array(report.artifacts).map((artifact) => {
        keys(artifact, ["sha256", "bytes", "kind"]);
        digest(artifact.sha256);
        integer(artifact.bytes);
        oneOf(artifact.kind, ["trace", "raw", "fixture", "grader", "build"]);
        return artifact.sha256;
      }),
    );
    const artifacts = new Map(report.artifacts.map((artifact) => [artifact.sha256, artifact]));
    const artifactHashes = new Set(artifacts.keys());
    const traces = new Set(
      array(report.traces).map((trace) => {
        keys(trace, ["id", "artifactHash", "clock"]);
        opaque(trace.id);
        digest(trace.artifactHash);
        check(artifacts.get(trace.artifactHash)?.kind === "trace", "trace artifact missing");
        oneOf(trace.clock, ["monotonic", "calibrated", "request-boundary", "virtual"]);
        check(
          (trace.clock === "virtual") === (report.scenario.tier === "T0"),
          "trace clock incompatible with tier",
        );
        return trace.id;
      }),
    );
    check(traces.size === report.traces.length, "duplicate trace IDs");
    const traceRef = (id: string) => check(traces.has(id), "unknown trace reference");
    registry(report.metrics, METRIC_DEFINITIONS);
    for (const metric of report.metrics) {
      keys(metric, [
        "id",
        "unit",
        "direction",
        "applicability",
        "missingReason",
        "coverage",
        "observations",
      ]);
      const definition = METRIC_DEFINITIONS.find((item) => item.id === metric.id)!;
      check(
        metric.unit === definition.unit && metric.direction === definition.direction,
        "metric unit or direction mismatch",
      );
      oneOf(metric.applicability, ["applicable", "not-applicable"]);
      array(metric.observations);
      unique(
        metric.observations.map((observation) => {
          keys(observation, [
            "id",
            "sessionId",
            "pairId",
            "traceId",
            "outcome",
            "value",
            "missingReason",
            "provenance",
          ]);
          opaque(observation.id);
          opaque(observation.sessionId);
          if (observation.pairId !== null) opaque(observation.pairId);
          traceRef(observation.traceId);
          outcome(observation.outcome);
          evidenceValue(
            observation,
            metric.unit === "count" || metric.unit === "tokens",
            artifactHashes,
          );
          if (observation.value !== null) {
            if (metric.id === "m05.cache-token-hit" || metric.id === "m05.cache-request-hit")
              check(
                report.scenario.tier === "T3" && observation.provenance?.kind === "provider-live",
                "cache hits require live provider evidence",
              );
            if (definition.familyId === "m10")
              check(
                report.environment.memoryAccounting !== "not-measured",
                "memory observations require an accounting method",
              );
          }
          if (observation.value !== null && definition.maximum !== null)
            check(observation.value <= definition.maximum, "metric above valid range");
          if (observation.provenance?.kind === "provider-live")
            check(report.scenario.tier === "T3", "live provenance requires T3");
          if (observation.provenance?.kind === "virtual")
            check(report.scenario.tier === "T0", "virtual provenance requires T0");
          return observation.id;
        }),
      );
      const measured = metric.observations.filter(
        (observation) => observation.value !== null,
      ).length;
      unique(
        metric.observations.flatMap((observation) =>
          observation.pairId === null ? [] : [observation.pairId],
        ),
      );
      coverage(metric.coverage, measured);
      check(
        metric.coverage.expected >= metric.observations.length,
        "observations exceed expected coverage",
      );
      if (metric.applicability === "not-applicable") {
        check(
          metric.missingReason === "not-applicable" &&
            metric.coverage.expected === 0 &&
            metric.observations.length === 0,
          "invalid not-applicable metric",
        );
      } else if (measured === metric.coverage.expected && measured > 0) {
        check(metric.missingReason === null, "complete metric cannot have a missing reason");
      } else missing(metric.missingReason);
    }
    registry(report.tasks, TASK_DEFINITIONS);
    for (const task of report.tasks) {
      keys(task, ["id", "status", "missingReason", "fixtureHash", "graderHash", "trials"]);
      status(task);
      for (const hash of [task.fixtureHash, task.graderHash]) if (hash !== null) digest(hash);
      unique(
        array(task.trials).map((trial) => {
          keys(trial, [
            "id",
            "sessionId",
            "pairId",
            "traceId",
            "outcome",
            "passed",
            "criticalPassed",
            "withinDeadline",
          ]);
          opaque(trial.id);
          opaque(trial.sessionId);
          if (trial.pairId !== null) opaque(trial.pairId);
          traceRef(trial.traceId);
          outcome(trial.outcome);
          for (const flag of [trial.passed, trial.criticalPassed, trial.withinDeadline])
            check(typeof flag === "boolean", "invalid task result");
          if (trial.passed)
            check(
              trial.outcome === "success" && trial.criticalPassed && trial.withinDeadline,
              "task pass contradicts outcome, safety or deadline",
            );
          return trial.id;
        }),
      );
      unique(task.trials.flatMap((trial) => (trial.pairId === null ? [] : [trial.pairId])));
      if (task.trials.length || task.status === "complete") {
        digest(task.fixtureHash);
        digest(task.graderHash);
      }
      if (task.status === "complete") check(task.trials.length > 0, "complete task needs trials");
      if (task.status === "feature-not-implemented")
        check(task.trials.length === 0, "unimplemented task cannot have trials");
    }
    registry(report.experiments, EXPERIMENT_DEFINITIONS);
    for (const experiment of report.experiments) {
      keys(experiment, ["id", "variants"]);
      const definition = EXPERIMENT_DEFINITIONS.find((item) => item.id === experiment.id)!;
      registry(
        experiment.variants,
        definition.variants.map((id) => ({ id })),
      );
      for (const variant of experiment.variants) {
        keys(variant, ["id", "status", "missingReason", "traceIds"]);
        status(variant);
        traceList(variant, traceRef);
        if (variant.status === "complete")
          check(definition.tiers.includes(report.scenario.tier), "experiment tier incompatible");
      }
    }
    registry(report.crashes, CRASH_BOUNDARIES);
    for (const crash of report.crashes) {
      keys(crash, [
        "id",
        "status",
        "missingReason",
        "recovery",
        "safetyPassed",
        "taskCompleted",
        "traceIds",
      ]);
      status(crash);
      traceList(crash, traceRef);
      if (crash.status === "complete") {
        oneOf(crash.recovery, ["automatic-recovery", "safe-retry", "explicit-uncertainty"]);
        check(
          crash.recovery ===
            CRASH_BOUNDARIES.find((boundary) => boundary.id === crash.id)!.expected,
          "recovery does not match boundary",
        );
        check(
          typeof crash.safetyPassed === "boolean" && typeof crash.taskCompleted === "boolean",
          "missing crash result",
        );
        if (crash.recovery === "explicit-uncertainty")
          check(!crash.taskCompleted, "uncertainty is not task completion");
      } else
        check(
          crash.recovery === null && crash.taskCompleted === null && crash.safetyPassed !== true,
          "incomplete crash cannot claim recovery or a passed safety result",
        );
    }
    unique(array(report.usage).map((request) => request.requestId));
    const requestIds = new Set(report.usage.map((request) => request.requestId));
    const counterSamples = new Set<string>();
    for (const request of report.usage) {
      validateUsage(request, artifactHashes);
      if (request.counter.mode === "cumulative-difference") {
        const key = canonicalSerialize([
          request.routeId,
          request.counter.epochId,
          request.counter.sequence,
        ]);
        check(!counterSamples.has(key), "duplicate cumulative counter sample");
        counterSamples.add(key);
      }
      traceRef(request.traceId);
      if (request.parentRequestId !== null)
        check(
          requestIds.has(request.parentRequestId) && request.parentRequestId !== request.requestId,
          "invalid parent request",
        );
      for (const category of Object.values(request.categories)) {
        if (category.provenance?.kind === "provider-live")
          check(report.scenario.tier === "T3", "live usage requires T3");
        if (category.provenance?.kind === "recorded-provider")
          check(
            request.usageRequestHash === request.requestHash,
            "recorded usage does not measure a changed request",
          );
      }
    }
    const requests = new Map(report.usage.map((request) => [request.requestId, request]));
    for (const request of report.usage) {
      const seen = new Set<string>();
      let cursor: RequestUsageEvidence | undefined = request;
      while (cursor) {
        check(!seen.has(cursor.requestId), "cyclic request attribution");
        seen.add(cursor.requestId);
        cursor = cursor.parentRequestId === null ? undefined : requests.get(cursor.parentRequestId);
      }
    }
    const observedUsage = report.usage.filter((request) =>
      USAGE_CATEGORIES.every((key) => {
        const category = request.categories[key];
        return (
          category.value !== null &&
          category.provenance?.kind !== "estimated" &&
          category.provenance?.kind !== "virtual"
        );
      }),
    ).length;
    coverage(report.usageCoverage, observedUsage);
    check(
      report.usageCoverage.expected === report.usage.length,
      "usage coverage must retain every attempted request",
    );
    return report;
  } catch (error) {
    throw invalidReport(source, error instanceof Error ? error.message : "malformed evidence");
  }
}

function validateUsage(request: RequestUsageEvidence, artifactHashes: ReadonlySet<string>) {
  keys(request, [
    "requestId",
    "turnId",
    "attemptId",
    "parentRequestId",
    "purpose",
    "routeId",
    "traceId",
    "outcome",
    "inputSemantics",
    "reasoningSemantics",
    "requestHash",
    "usageRequestHash",
    "counter",
    "categories",
  ]);
  for (const id of [
    request.requestId,
    request.turnId,
    request.attemptId,
    request.routeId,
    request.traceId,
  ])
    opaque(id);
  if (request.parentRequestId !== null) opaque(request.parentRequestId);
  oneOf(request.purpose, ["main", "retry", "helper", "summary", "delegated", "detached-learning"]);
  outcome(request.outcome);
  oneOf(request.inputSemantics, [
    "total-with-cache-subsets",
    "additive-cache-categories",
    "unknown",
  ]);
  oneOf(request.reasoningSemantics, ["subset-of-output", "separate", "unknown"]);
  digest(request.requestHash);
  digest(request.usageRequestHash);
  keys(request.counter, ["mode", "epochId", "sequence"]);
  oneOf(request.counter.mode, ["request-delta", "cumulative-difference"]);
  opaque(request.counter.epochId);
  integer(request.counter.sequence);
  keys(request.categories, [...USAGE_CATEGORIES]);
  for (const category of Object.values(request.categories)) {
    keys(category, ["value", "missingReason", "provenance"]);
    evidenceValue(category, true, artifactHashes);
  }
  const { logicalInput, uncachedInput, cacheReadInput, cacheWriteInput, output, reasoning } =
    request.categories;
  const parts = [uncachedInput.value, cacheReadInput.value, cacheWriteInput.value];
  if (request.inputSemantics !== "unknown" && logicalInput.value !== null) {
    const suppliedTotal = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
    check(suppliedTotal <= logicalInput.value, "input categories exceed logical input");
    if (parts.every((part) => part !== null))
      check(
        suppliedTotal === logicalInput.value,
        "input categories must partition logical input without double counting",
      );
  }
  if (request.inputSemantics === "unknown")
    check(
      parts.every((part) => part === null),
      "unknown input semantics cannot claim cache categories",
    );
  if (
    request.reasoningSemantics === "subset-of-output" &&
    reasoning.value !== null &&
    output.value !== null
  )
    check(reasoning.value <= output.value, "reasoning subset exceeds output");
  if (request.reasoningSemantics === "unknown")
    check(reasoning.value === null, "unknown reasoning semantics cannot claim reasoning tokens");
}

export interface RequiredEvidenceSelection {
  metricIds: string[];
  taskIds: string[];
  experimentIds: string[];
  crashBoundaryIds: string[];
  usage: boolean;
}

export interface PerformanceEvidenceEnvelope {
  sha256: string;
  report: PerformanceEvidenceReport;
}

/** Content identity binds even an uncommitted build to its base commit and diff digest. */
export function createPerformanceEvidenceEnvelope(
  value: PerformanceEvidenceReport,
): PerformanceEvidenceEnvelope {
  const report = parsePerformanceEvidenceReport(value, "envelope");
  return { sha256: contentDigest(report), report };
}

export function parsePerformanceEvidenceEnvelope(value: unknown): PerformanceEvidenceEnvelope {
  const copy = JSON.parse(canonicalSerialize(value)) as PerformanceEvidenceEnvelope;
  keys(copy, ["sha256", "report"]);
  digest(copy.sha256);
  check(copy.sha256 === contentDigest(copy.report), "report checksum mismatch");
  return { sha256: copy.sha256, report: parsePerformanceEvidenceReport(copy.report, "envelope") };
}

/** Completeness only. Statistical verdicts, calibration and release policy belong to W0-8. */
export function assertRequiredEvidence(
  value: PerformanceEvidenceReport,
  required: RequiredEvidenceSelection,
  allowDirty = false,
): void {
  const report = parsePerformanceEvidenceReport(value, "required-evidence");
  check(allowDirty || !report.build.dirty, "dirty build is not release evidence");
  keys(required, ["metricIds", "taskIds", "experimentIds", "crashBoundaryIds", "usage"]);
  for (const [ids, definitions] of [
    [required.metricIds, METRIC_DEFINITIONS],
    [required.taskIds, TASK_DEFINITIONS],
    [required.experimentIds, EXPERIMENT_DEFINITIONS],
    [required.crashBoundaryIds, CRASH_BOUNDARIES],
  ] as const) {
    unique(array(ids));
    for (const id of ids)
      check(
        definitions.some((definition) => definition.id === id),
        "unknown required definition",
      );
  }
  check(typeof required.usage === "boolean", "invalid usage requirement");
  for (const id of required.metricIds) {
    const metric = report.metrics.find((item) => item.id === id)!;
    check(
      metric.applicability === "applicable" &&
        metric.coverage.expected > 0 &&
        metric.coverage.observed === metric.coverage.expected &&
        metric.missingReason === null,
      `incomplete required metric ${id}`,
    );
    if (metric.unit === "ms" || metric.unit === "joules" || metric.unit === "watts")
      check(report.scenario.tier !== "T0", "T0 cannot satisfy performance evidence");
    check(
      metric.observations.every(
        (observation) =>
          observation.provenance?.kind !== "estimated" &&
          observation.provenance?.kind !== "virtual",
      ),
      "estimates and virtual time cannot satisfy measured coverage",
    );
  }
  for (const id of required.taskIds)
    check(
      report.tasks.find((task) => task.id === id)?.status === "complete",
      `incomplete required task ${id}`,
    );
  for (const id of required.experimentIds)
    check(
      report.experiments
        .find((experiment) => experiment.id === id)
        ?.variants.every((variant) => variant.status === "complete"),
      `incomplete required experiment ${id}`,
    );
  for (const id of required.crashBoundaryIds) {
    check(report.scenario.tier === "T1", "durable crash evidence requires T1");
    check(
      report.crashes.find((crash) => crash.id === id)?.status === "complete",
      `incomplete required crash ${id}`,
    );
  }
  if (required.usage)
    check(
      report.usageCoverage.expected > 0 &&
        report.usageCoverage.observed === report.usageCoverage.expected,
      "incomplete required usage",
    );
}

export function assertComparablePerformanceEvidence(
  before: PerformanceEvidenceReport,
  after: PerformanceEvidenceReport,
): void {
  const left = parsePerformanceEvidenceReport(before, "before");
  const right = parsePerformanceEvidenceReport(after, "after");
  assertMatchingEvidencePlan(left, right);
  check(
    left.build.commit === right.build.parentCommit ||
      left.build.commit === right.build.fixedReleaseCommit,
    "undeclared comparison baseline",
  );
}

/** A/A calibration repeats one build; it does not compare a candidate to a baseline. */
export function assertCalibrationPerformanceEvidence(
  before: PerformanceEvidenceReport,
  after: PerformanceEvidenceReport,
): void {
  const left = parsePerformanceEvidenceReport(before, "calibration-before");
  const right = parsePerformanceEvidenceReport(after, "calibration-after");
  check(
    canonicalSerialize(left.build) === canonicalSerialize(right.build),
    "calibration requires identical build provenance",
  );
  assertMatchingEvidencePlan(left, right);
}

function assertMatchingEvidencePlan(
  left: PerformanceEvidenceReport,
  right: PerformanceEvidenceReport,
) {
  for (const key of ["manifestHash", "environmentHash", "hashes", "scenario"] as const)
    check(canonicalSerialize(left[key]) === canonicalSerialize(right[key]), `incompatible ${key}`);
  check(
    left.build.fixedReleaseCommit === right.build.fixedReleaseCommit,
    "incompatible fixed-release baseline",
  );
  check(
    canonicalSerialize(
      left.metrics
        .map(({ id, applicability, coverage: plan, observations }) => ({
          id,
          applicability,
          expected: plan.expected,
          pairs: observations.map(({ pairId }) => pairId).sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ) ===
      canonicalSerialize(
        right.metrics
          .map(({ id, applicability, coverage: plan, observations }) => ({
            id,
            applicability,
            expected: plan.expected,
            pairs: observations.map(({ pairId }) => pairId).sort(),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    "incompatible measurement plan",
  );
  const taskBindings = (report: PerformanceEvidenceReport) =>
    report.tasks
      .map(({ id, fixtureHash, graderHash, trials }) => ({
        id,
        fixtureHash,
        graderHash,
        trials: trials.length,
        pairs: trials.flatMap(({ pairId }) => (pairId === null ? [] : [pairId])).sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  check(
    canonicalSerialize(taskBindings(left)) === canonicalSerialize(taskBindings(right)),
    "incompatible task bindings",
  );
}

function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  const sorted = [...expected].sort();
  check(
    isRecord(value) &&
      Object.keys(value).length === sorted.length &&
      Object.keys(value)
        .sort()
        .every((key, index) => key === sorted[index]),
    `expected exact keys: ${expected.join(", ")}`,
  );
}
function array<T>(value: T[]): T[] {
  check(Array.isArray(value), "expected array");
  return value;
}
function unique(values: unknown[]) {
  check(new Set(values).size === values.length, "duplicate identifiers");
}
function opaque(value: unknown) {
  check(
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value),
    "expected opaque identifier or version label",
  );
}
function digest(value: unknown) {
  check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "expected SHA-256 digest");
}
function integer(value: unknown) {
  check(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "expected nonnegative safe integer",
  );
}
function positive(value: unknown) {
  check(isFiniteNumber(value) && value > 0, "expected positive finite number");
}
function oneOf(value: unknown, choices: readonly string[]) {
  check(typeof value === "string" && choices.includes(value), "unsupported enum value");
}
function missing(value: unknown) {
  oneOf(value, MISSING_REASONS);
}
function outcome(value: unknown) {
  oneOf(value, ["success", "failed", "cancelled", "timed-out", "uncertain"]);
}
function evidenceValue(
  value: EvidenceValue,
  integral: boolean,
  artifactHashes: ReadonlySet<string>,
) {
  if (value.value === null) {
    missing(value.missingReason);
    check(value.provenance === null, "missing value cannot claim provenance");
    return;
  }
  check(
    isFiniteNumber(value.value) && value.value >= 0 && value.missingReason === null,
    "invalid observation value or missing reason",
  );
  if (integral) integer(value.value);
  keys(value.provenance, ["kind", "sourceHash"]);
  oneOf(value.provenance.kind, [
    "measured",
    "provider-live",
    "recorded-provider",
    "counted",
    "estimated",
    "virtual",
  ]);
  digest(value.provenance.sourceHash);
  check(artifactHashes.has(value.provenance.sourceHash), "observation source artifact missing");
}
function coverage(value: { expected: number; observed: number }, observed: number) {
  keys(value, ["expected", "observed"]);
  integer(value.expected);
  integer(value.observed);
  check(
    value.observed === observed && value.expected >= observed,
    "coverage does not match raw observations",
  );
}
function registry<T extends { id: string }>(values: T[], definitions: readonly { id: string }[]) {
  const ids = array(values).map((value) => value?.id);
  unique(ids);
  check(
    ids.length === definitions.length &&
      definitions.every((definition) => ids.includes(definition.id)),
    "missing or unknown registry definition",
  );
}
function status(value: { status: string; missingReason: MissingReason | null }) {
  oneOf(value.status, ["complete", "incomplete", "feature-not-implemented"]);
  if (value.status === "complete")
    check(value.missingReason === null, "complete evidence cannot be missing");
  else if (value.status === "feature-not-implemented")
    check(
      value.missingReason === "feature-not-implemented",
      "unimplemented evidence needs its missing reason",
    );
  else missing(value.missingReason);
}
function traceList(value: { status: string; traceIds: string[] }, reference: (id: string) => void) {
  unique(array(value.traceIds));
  for (const id of value.traceIds) reference(id);
  if (value.status === "complete")
    check(value.traceIds.length > 0, "complete evidence requires traces");
  if (value.status === "feature-not-implemented")
    check(value.traceIds.length === 0, "unimplemented evidence cannot have traces");
}
