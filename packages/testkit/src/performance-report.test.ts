import { describe, expect, it } from "vitest";
import { createTraceBuffer } from "../../adapters/src/scoreboard-trace.js";
import {
  parsePerformanceReport,
  parseTcpPort,
  percentageDelta,
  roundMetric,
  summarize,
} from "./performance-report";
import type {
  EvidenceValue,
  PerformanceEvidenceReport,
  RequestUsageEvidence,
  RequiredEvidenceSelection,
} from "./performance-report.js";
import {
  assertCalibrationPerformanceEvidence,
  assertComparablePerformanceEvidence,
  assertRequiredEvidence,
  createPerformanceEvidenceEnvelope,
  PERFORMANCE_EVIDENCE_SCHEMA_VERSION,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  parsePerformanceEvidenceEnvelope,
  parsePerformanceEvidenceReport,
  readPerformanceReport,
} from "./performance-report.js";
import { matrixEvidence } from "./scoreboard/experiments/evidence.js";
import {
  CRASH_BOUNDARIES,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  SCOREBOARD_MANIFEST,
  TASK_DEFINITIONS,
} from "./scoreboard/manifest.js";
import { collectTraceEvidence } from "./scoreboard/trace-collector.js";

describe("performance report statistics", () => {
  it("summarizes a distribution without mutating it", () => {
    const values = [40, 10, 30, 20];

    expect(summarize(values)).toEqual({
      count: 4,
      min: 10,
      median: 25,
      p95: 38.5,
      max: 40,
    });
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it("calculates comparable percentage deltas", () => {
    expect(percentageDelta(100, 75)).toBe(-25);
    expect(percentageDelta(0, 0)).toBe(0);
    expect(percentageDelta(0, 1)).toBeNull();
    expect(roundMetric(1.23456)).toBe(1.23);
  });

  it("rejects an empty distribution", () => {
    expect(() => summarize([])).toThrow("empty sample");
  });
});

describe("performance report input", () => {
  it("rejects missing and unknown report schemas with a useful source name", () => {
    expect(() => parsePerformanceReport({}, "before.json")).toThrow(
      "Invalid performance report before.json: unsupported schemaVersion undefined",
    );
    expect(() => parsePerformanceReport({ schemaVersion: 99 }, "after.json")).toThrow(
      "Invalid performance report after.json: unsupported schemaVersion 99",
    );
  });

  it("migrates schema 1 memory labels to working-set labels", () => {
    const distribution = { count: 1, min: 10, median: 10, p95: 10, max: 10 };
    const report = parsePerformanceReport(
      {
        schemaVersion: 1,
        label: "before",
        environment: {},
        summary: {
          cacheColdShellUsableMs: distribution,
          warmShellUsableMs: distribution,
          settingsPaintedMs: 10,
          settingsSettledMs: 10,
          typingKeyPaintMs: distribution,
          idleCpuPercent: distribution,
          idleSummedPrivateKiB: distribution,
          streamingCpuPercent: distribution,
        },
      },
      "legacy.json",
    );

    expect(report.schemaVersion).toBe(2);
    expect(report.summary.idleSummedWorkingSetKiB).toEqual(distribution);
    expect(report.summary.hiddenSummedWorkingSetKiB).toBeNull();
  });

  it("validates configured TCP ports", () => {
    expect(parseTcpPort("55400", "PERF_WEB_PORT")).toBe(55_400);
    for (const value of ["", "nope", "0", "65536", "1.5", "Infinity"]) {
      expect(() => parseTcpPort(value, "PERF_WEB_PORT")).toThrow(
        "PERF_WEB_PORT must be an integer between 1 and 65535",
      );
    }
  });
});

const hash = (value: string) => contentDigest(value);
const known = (value: number): EvidenceValue => ({
  value,
  missingReason: null,
  provenance: { kind: "measured", sourceHash: hash("synthetic-source") },
});
const unknown = (): EvidenceValue => ({
  value: null,
  missingReason: "provider-omitted",
  provenance: null,
});

function evidence(): PerformanceEvidenceReport {
  const environment: PerformanceEvidenceReport["environment"] = {
    platform: "linux",
    arch: "x64",
    hardwareClass: "fixture-small",
    osVersion: "fixture-1",
    runtimeVersions: [{ id: "node", version: "26.7.0" }],
    containerDigests: [hash("container")],
    buildMode: "production",
    powerMode: "fixed",
    thermalState: "nominal",
    backgroundLoad: "isolated",
    memoryAccounting: "rss",
    resourceLimitsHash: hash("resources"),
    sampleIntervalMs: 1000,
  };
  return {
    schemaVersion: 3,
    id: "report-01",
    createdAt: "2026-09-24T00:00:00.000Z",
    manifestHash: contentDigest(SCOREBOARD_MANIFEST),
    build: {
      commit: "a".repeat(40),
      parentCommit: "b".repeat(40),
      fixedReleaseCommit: "c".repeat(40),
      dirty: false,
      diffDigest: null,
      artifactHash: hash("build"),
    },
    hashes: {
      benchmark: hash("benchmark"),
      fixture: hash("fixture"),
      grader: hash("grader"),
      dependencyLock: hash("lock"),
    },
    environment,
    environmentHash: contentDigest(environment),
    scenario: {
      id: "scenario-01",
      tier: "T1",
      comparisonMode: "controlled-harness",
      timingMode: "zero-service-delay",
      cacheState: "cold",
      loadScheduleHash: hash("load"),
      routeHash: hash("pin-and-route"),
      deadlineMs: 1000,
    },
    artifacts: [
      { sha256: hash("trace"), bytes: 1, kind: "trace" },
      { sha256: hash("synthetic-source"), bytes: 1, kind: "raw" },
    ],
    traces: [{ id: "trace-01", artifactHash: hash("trace"), clock: "monotonic" }],
    metrics: METRIC_DEFINITIONS.map((metric) => ({
      id: metric.id,
      unit: metric.unit,
      direction: metric.direction,
      applicability: "applicable",
      missingReason: "not-measured",
      coverage: { expected: 0, observed: 0 },
      observations: [],
    })),
    tasks: TASK_DEFINITIONS.map(({ id }) => ({
      id,
      status: "incomplete",
      missingReason: "not-measured",
      fixtureHash: null,
      graderHash: null,
      trials: [],
    })),
    experiments: EXPERIMENT_DEFINITIONS.map(({ id, variants }) => ({
      id,
      variants: variants.map((variant) => ({
        id: variant,
        status: "feature-not-implemented",
        missingReason: "feature-not-implemented",
        traceIds: [],
      })),
    })),
    crashes: CRASH_BOUNDARIES.map(({ id }) => ({
      id,
      status: "incomplete",
      missingReason: "not-measured",
      recovery: null,
      safetyPassed: null,
      taskCompleted: null,
      traceIds: [],
    })),
    usageCoverage: { expected: 0, observed: 0 },
    usage: [],
  };
}

function measured(report: PerformanceEvidenceReport, id = "m01.user-ttft", values = [0, 10]) {
  const metric = report.metrics.find((item) => item.id === id)!;
  metric.observations = values.map((value, index) => ({
    ...known(value),
    id: `observation-${index}`,
    sessionId: `session-${index}`,
    pairId: `pair-${index}`,
    traceId: "trace-01",
    outcome: "success",
  }));
  metric.coverage = { expected: values.length, observed: values.length };
  metric.missingReason = null;
  return metric;
}

function usage(report: PerformanceEvidenceReport): RequestUsageEvidence {
  const request: RequestUsageEvidence = {
    requestId: "request-01",
    turnId: "turn-01",
    attemptId: "attempt-01",
    parentRequestId: null,
    purpose: "main",
    routeId: "route-01",
    traceId: "trace-01",
    outcome: "success",
    inputSemantics: "total-with-cache-subsets",
    reasoningSemantics: "subset-of-output",
    requestHash: hash("request"),
    usageRequestHash: hash("request"),
    counter: { mode: "request-delta", epochId: "epoch-01", sequence: 0 },
    categories: {
      logicalInput: known(100),
      uncachedInput: known(60),
      cacheReadInput: known(30),
      cacheWriteInput: known(10),
      output: known(50),
      reasoning: known(20),
    },
  };
  report.usage.push(request);
  report.usageCoverage = { expected: 1, observed: 1 };
  return request;
}

const required = (
  overrides: Partial<RequiredEvidenceSelection> = {},
): RequiredEvidenceSelection => ({
  metricIds: [],
  taskIds: [],
  experimentIds: [],
  crashBoundaryIds: [],
  usage: false,
  ...overrides,
});

describe("versioned performance evidence", () => {
  it("round trips raw zero observations and leaves incomplete definitions visible", () => {
    const report = evidence();
    measured(report);
    expect(readPerformanceReport(report, "raw.json")).toEqual(report);
    expect(() =>
      assertRequiredEvidence(report, required({ metricIds: ["m01.user-ttft"] })),
    ).not.toThrow();
    expect(() =>
      assertRequiredEvidence(report, required({ metricIds: ["m08.eligible-to-lease"] })),
    ).toThrow("incomplete required metric");
  });

  it("retains all five outcomes, valid slow trials, cold misses and measured zero counts", () => {
    const report = evidence();
    const metric = measured(report, "m13.retries", [0, 1, 2, 3, 100]);
    metric.observations.forEach((item, index) => {
      item.outcome = (["success", "failed", "cancelled", "timed-out", "uncertain"] as const)[
        index
      ]!;
    });
    expect(
      parsePerformanceEvidenceReport(report, "outcomes").metrics.find(
        (item) => item.id === metric.id,
      )?.observations,
    ).toEqual(metric.observations);
  });

  it("keeps schema 2 unchanged and never invents schema 3 evidence for historical reports", () => {
    const distribution = summarize([0, 10]);
    const legacy = {
      schemaVersion: 2,
      label: "historical",
      environment: {},
      summary: {
        cacheColdShellUsableMs: distribution,
        warmShellUsableMs: distribution,
        settingsPaintedMs: 0,
        settingsSettledMs: 0,
        typingKeyPaintMs: distribution,
        idleCpuPercent: distribution,
        idleSummedWorkingSetKiB: distribution,
        streamingCpuPercent: distribution,
        reopenMs: null,
        hiddenSummedWorkingSetKiB: null,
      },
    };
    expect(readPerformanceReport(legacy, "legacy.json")).toEqual(legacy);
    expect(readPerformanceReport(legacy, "legacy.json")).not.toHaveProperty("metrics");
    expect(PERFORMANCE_REPORT_SCHEMA_VERSION).toBe(2);
    expect(PERFORMANCE_EVIDENCE_SCHEMA_VERSION).toBe(3);
    expect(() => parsePerformanceReport(evidence(), "new.json")).toThrow(
      "unsupported schemaVersion",
    );
  });

  it.each(Object.keys(evidence()))("rejects a missing required report key %s", (key) => {
    const report = { ...evidence() } as Record<string, unknown>;
    delete report[key];
    expect(() => parsePerformanceEvidenceReport(report, "missing.json")).toThrow(
      "Invalid performance report missing.json",
    );
  });

  it.each([
    [
      "extra keys",
      (report: PerformanceEvidenceReport) =>
        Object.assign(report, { prompt: "synthetic-forbidden-content" }),
    ],
    [
      "wrong schema",
      (report: PerformanceEvidenceReport) => Object.assign(report, { schemaVersion: 99 }),
    ],
    ["missing metric", (report: PerformanceEvidenceReport) => report.metrics.pop()],
    [
      "duplicate metric",
      (report: PerformanceEvidenceReport) => report.metrics.push(report.metrics[0]!),
    ],
    [
      "unknown metric",
      (report: PerformanceEvidenceReport) => {
        report.metrics[0]!.id = "m99.invalid";
      },
    ],
    ["missing task", (report: PerformanceEvidenceReport) => report.tasks.pop()],
    ["missing experiment", (report: PerformanceEvidenceReport) => report.experiments.pop()],
    [
      "missing variant",
      (report: PerformanceEvidenceReport) => report.experiments[0]!.variants.pop(),
    ],
    ["missing crash", (report: PerformanceEvidenceReport) => report.crashes.pop()],
    [
      "direction reversal",
      (report: PerformanceEvidenceReport) => {
        report.metrics[0]!.direction = "higher";
      },
    ],
    [
      "wrong unit",
      (report: PerformanceEvidenceReport) => {
        report.metrics[0]!.unit = "bytes";
      },
    ],
    [
      "bad fixture hash",
      (report: PerformanceEvidenceReport) => {
        report.hashes.fixture = "unknown";
      },
    ],
    [
      "bad manifest hash",
      (report: PerformanceEvidenceReport) => {
        report.manifestHash = hash("other");
      },
    ],
    [
      "dirty without digest",
      (report: PerformanceEvidenceReport) => {
        report.build.dirty = true;
      },
    ],
    [
      "clean with digest",
      (report: PerformanceEvidenceReport) => {
        report.build.diffDigest = hash("patch");
      },
    ],
    [
      "environment tampering",
      (report: PerformanceEvidenceReport) => {
        report.environment.arch = "arm64";
      },
    ],
    [
      "private path field",
      (report: PerformanceEvidenceReport) => {
        report.environment.hardwareClass = "/synthetic/private/machine";
      },
    ],
    [
      "orphan trace",
      (report: PerformanceEvidenceReport) => {
        report.traces[0]!.artifactHash = hash("absent");
      },
    ],
    [
      "duplicate trace",
      (report: PerformanceEvidenceReport) => report.traces.push(report.traces[0]!),
    ],
    [
      "bad timestamp",
      (report: PerformanceEvidenceReport) => {
        report.createdAt = "2026-02-30T00:00:00.000Z";
      },
    ],
    [
      "virtual clock in replay",
      (report: PerformanceEvidenceReport) => {
        report.traces[0]!.clock = "virtual";
      },
    ],
    [
      "live timing in replay",
      (report: PerformanceEvidenceReport) => {
        report.scenario.timingMode = "live";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const report = evidence();
    (mutate as (report: PerformanceEvidenceReport) => void)(report);
    expect(() => parsePerformanceEvidenceReport(report, "negative-control")).toThrow();
  });

  it.each([-1, NaN, Infinity, -Infinity])("rejects invalid raw durations %s", (value) => {
    const report = evidence();
    measured(report, "m01.user-ttft", [value]);
    expect(() => parsePerformanceEvidenceReport(report, "duration")).toThrow();
  });

  it("rejects fractional counts, out-of-range ratios and unsupported missing reasons", () => {
    const report = evidence();
    measured(report, "m13.retries", [0.5]);
    expect(() => parsePerformanceEvidenceReport(report, "count")).toThrow("integer");
    measured(report, "m13.retries", [0]);
    measured(report, "m12.outcome-pass", [1.1]);
    expect(() => parsePerformanceEvidenceReport(report, "ratio")).toThrow("range");
    measured(report, "m12.outcome-pass", [1]);
    Object.assign(report.metrics[0], { missingReason: "silently-skipped" });
    expect(() => parsePerformanceEvidenceReport(report, "reason")).toThrow("enum");
  });

  it("does not allow missing samples or zero samples to become complete coverage", () => {
    const report = evidence();
    const metric = measured(report);
    metric.observations[0] = { ...metric.observations[0]!, ...unknown() };
    expect(() => parsePerformanceEvidenceReport(report, "coverage")).toThrow("coverage");
    metric.coverage.observed = 1;
    metric.missingReason = "provider-omitted";
    expect(
      parsePerformanceEvidenceReport(report, "coverage").metrics[0]!.observations[0]!.value,
    ).toBeNull();
    expect(() => assertRequiredEvidence(report, required({ metricIds: [metric.id] }))).toThrow(
      "incomplete",
    );
    measured(report, metric.id, []);
    expect(() => parsePerformanceEvidenceReport(report, "empty")).toThrow();
  });

  it("records non-applicability but cannot use it to waive a trusted requirement", () => {
    const report = evidence();
    const metric = report.metrics[0]!;
    metric.applicability = "not-applicable";
    metric.missingReason = "not-applicable";
    expect(() => parsePerformanceEvidenceReport(report, "na")).not.toThrow();
    expect(() => assertRequiredEvidence(report, required({ metricIds: [metric.id] }))).toThrow(
      "incomplete",
    );
    expect(() => assertRequiredEvidence(report, required({ metricIds: ["unknown"] }))).toThrow(
      "unknown required",
    );
  });

  it("requires source-compatible tiers and never accepts virtual or estimated timing as performance", () => {
    const report = evidence();
    const metric = measured(report);
    metric.observations[0]!.provenance!.kind = "provider-live";
    expect(() => parsePerformanceEvidenceReport(report, "live")).toThrow("T3");
    metric.observations[0]!.provenance!.kind = "estimated";
    expect(() => assertRequiredEvidence(report, required({ metricIds: [metric.id] }))).toThrow(
      "estimates",
    );
    report.scenario.tier = "T0";
    report.scenario.timingMode = "virtual";
    report.traces[0]!.clock = "virtual";
    metric.observations.forEach((item) => {
      item.provenance!.kind = "virtual";
    });
    expect(() => parsePerformanceEvidenceReport(report, "virtual")).not.toThrow();
    expect(() => assertRequiredEvidence(report, required({ metricIds: [metric.id] }))).toThrow(
      "T0",
    );
  });

  it("binds dirty work to a diff digest but requires explicit local diagnostic acceptance", () => {
    const report = evidence();
    measured(report);
    report.build.dirty = true;
    report.build.diffDigest = hash("patch");
    const selection = required({ metricIds: ["m01.user-ttft"] });
    expect(() => assertRequiredEvidence(report, selection)).toThrow("dirty");
    expect(() => assertRequiredEvidence(report, selection, true)).not.toThrow();
  });

  it("returns a detached snapshot and revalidates mutations before use", () => {
    const input = evidence();
    measured(input);
    const parsed = parsePerformanceEvidenceReport(input, "snapshot");
    input.metrics[0]!.observations[0]!.value = -1;
    expect(parsed.metrics[0]!.observations[0]!.value).toBe(0);
    parsed.metrics[0]!.observations[0]!.value = -1;
    expect(() => assertRequiredEvidence(parsed, required())).toThrow();
  });
});

describe("request usage attribution", () => {
  it.each(["total-with-cache-subsets", "additive-cache-categories"] as const)(
    "preserves %s without adding cached tokens or reasoning twice",
    (semantics) => {
      const report = evidence();
      const request = usage(report);
      request.inputSemantics = semantics;
      const parsed = parsePerformanceEvidenceReport(report, "usage").usage[0]!;
      expect(parsed.categories.logicalInput.value).toBe(100);
      expect(parsed.categories.output.value).toBe(50);
      expect(parsed.categories.reasoning.value).toBe(20);
      expect(() => assertRequiredEvidence(report, required({ usage: true }))).not.toThrow();
      request.categories.logicalInput = known(140);
      expect(() => parsePerformanceEvidenceReport(report, "double-count")).toThrow("partition");
    },
  );

  it("keeps main, retry, helper, summary, delegated and detached learning attributed separately", () => {
    const report = evidence();
    const base = usage(report);
    report.usage = (
      ["main", "retry", "helper", "summary", "delegated", "detached-learning"] as const
    ).map((purpose, index) => ({
      ...structuredClone(base),
      purpose,
      requestId: `request-${index}`,
      attemptId: `attempt-${index}`,
      parentRequestId: index ? "request-0" : null,
    }));
    report.usageCoverage = { expected: 6, observed: 6 };
    expect(parsePerformanceEvidenceReport(report, "purposes").usage).toHaveLength(6);
  });

  it.each(["failed", "cancelled", "timed-out", "uncertain"] as const)(
    "retains unknown usage on %s requests and rejects complete coverage claims",
    (outcome) => {
      const report = evidence();
      const request = usage(report);
      request.outcome = outcome;
      request.categories.logicalInput = unknown();
      expect(() => parsePerformanceEvidenceReport(report, "lost-usage")).toThrow("coverage");
      report.usageCoverage.observed = 0;
      expect(
        parsePerformanceEvidenceReport(report, "unknown").usage[0]!.categories.logicalInput.value,
      ).toBeNull();
      expect(() => assertRequiredEvidence(report, required({ usage: true }))).toThrow(
        "incomplete required usage",
      );
    },
  );

  it("rejects duplicate terminal usage and attribution cycles", () => {
    const report = evidence();
    const first = usage(report);
    report.usage.push(structuredClone(first));
    report.usageCoverage = { expected: 2, observed: 2 };
    expect(() => parsePerformanceEvidenceReport(report, "duplicate")).toThrow("duplicate");
    report.usage[1]!.requestId = "request-02";
    first.parentRequestId = "request-02";
    report.usage[1]!.parentRequestId = first.requestId;
    expect(() => parsePerformanceEvidenceReport(report, "cycle")).toThrow("cyclic");
  });

  it("rejects old recorded usage for changed prompts but permits explicit recounted input", () => {
    const report = evidence();
    const request = usage(report);
    request.categories.logicalInput.provenance!.kind = "recorded-provider";
    request.usageRequestHash = hash("old-request");
    expect(() => parsePerformanceEvidenceReport(report, "stale-recording")).toThrow(
      "changed request",
    );
    request.categories.logicalInput.provenance!.kind = "counted";
    expect(() => parsePerformanceEvidenceReport(report, "new-count")).not.toThrow();
  });

  it("keeps unknown categories null and enforces reasoning subsets and token ranges", () => {
    const report = evidence();
    const request = usage(report);
    request.categories.reasoning = known(51);
    expect(() => parsePerformanceEvidenceReport(report, "reasoning")).toThrow("subset");
    request.categories.reasoning = known(20);
    request.categories.uncachedInput = known(-1);
    expect(() => parsePerformanceEvidenceReport(report, "tokens")).toThrow();
    request.inputSemantics = "unknown";
    request.categories.uncachedInput = unknown();
    request.categories.cacheReadInput = unknown();
    request.categories.cacheWriteInput = unknown();
    request.reasoningSemantics = "unknown";
    request.categories.reasoning = unknown();
    report.usageCoverage.observed = 0;
    expect(() => parsePerformanceEvidenceReport(report, "unknown-semantics")).not.toThrow();
    request.categories.cacheReadInput = known(0);
    expect(() => parsePerformanceEvidenceReport(report, "invented-zero")).toThrow(
      "unknown input semantics",
    );
  });
});

describe("task, experiment and recovery evidence", () => {
  it("accepts a measured crash finding emitted by the matrix evidence adapter", () => {
    const report = evidence();
    report.crashes = matrixEvidence([
      {
        id: "crash-04",
        experiment: "O9",
        tier: "T1",
        status: "finding",
        checks: { killedAtBoundary: true, noDuplicateEffect: false },
        measurements: {},
        coverage: [],
        gaps: [],
      },
    ]).crashes;
    expect(() => parsePerformanceEvidenceReport(report, "matrix-finding")).not.toThrow();
  });
  it("accepts a complete crash from the matrix adapter only with trace links", () => {
    const phase = (processId: string, boundary: "admission.started" | "terminal.committed") => {
      const buffer = createTraceBuffer({ processId, now: () => 10 });
      buffer.record(
        "fixture-run",
        boundary,
        boundary === "terminal.committed" ? { outcome: "success" } : {},
      );
      return collectTraceEvidence([buffer.snapshot()], {
        sessionId: "matrix-fault",
        pairId: null,
        requiredBoundaries: [],
      });
    };
    const crash = {
      id: "crash-04",
      experiment: "O9" as const,
      tier: "T1" as const,
      status: "passed" as const,
      checks: { killedAtBoundary: true, noDuplicateEffect: true },
      measurements: {
        before: { trace: phase("interrupted-worker", "admission.started") },
        after: {
          autonomousCompletion: false,
          trace: phase("recovered-worker", "terminal.committed"),
        },
      },
      coverage: [],
      gaps: [],
    };
    const fragments = matrixEvidence([crash]);
    const report = evidence();
    report.crashes = fragments.crashes;
    expect(report.crashes[3]).toMatchObject({
      status: "complete",
      recovery: "explicit-uncertainty",
      safetyPassed: true,
      taskCompleted: false,
    });
    expect(report.crashes[3]!.traceIds).toHaveLength(1);
    report.traces.push(...fragments.traces);
    report.artifacts.push(...fragments.artifacts);
    expect(() =>
      assertRequiredEvidence(report, required({ crashBoundaryIds: ["crash-04"] })),
    ).not.toThrow();
    const untraced = evidence();
    untraced.crashes = matrixEvidence([
      { ...crash, measurements: { after: { autonomousCompletion: false } } },
    ]).crashes;
    expect(untraced.crashes[3]).toMatchObject({
      status: "incomplete",
      missingReason: "trace-links-missing",
      traceIds: [],
    });
    expect(() => parsePerformanceEvidenceReport(untraced, "untraced-crash")).not.toThrow();
    expect(() =>
      assertRequiredEvidence(untraced, required({ crashBoundaryIds: ["crash-04"] })),
    ).toThrow();
  });
  it("preserves task failures separately from evidence completeness", () => {
    const report = evidence();
    const task = report.tasks[0]!;
    Object.assign(task, {
      status: "complete",
      missingReason: null,
      fixtureHash: hash("task-fixture"),
      graderHash: hash("task-grader"),
      trials: [
        {
          id: "trial-01",
          sessionId: "session-01",
          pairId: "pair-01",
          traceId: "trace-01",
          outcome: "failed",
          passed: false,
          criticalPassed: true,
          withinDeadline: false,
        },
      ],
    });
    expect(() => assertRequiredEvidence(report, required({ taskIds: [task.id] }))).not.toThrow();
    task.trials[0]!.passed = true;
    expect(() => parsePerformanceEvidenceReport(report, "false-pass")).toThrow("contradicts");
  });

  it("never treats unimplemented snapshot or checkpoint variants as covered", () => {
    const report = evidence();
    for (const id of ["O11", "O13"])
      expect(() => assertRequiredEvidence(report, required({ experimentIds: [id] }))).toThrow(
        "incomplete",
      );
    const snapshot = report.experiments.find((item) => item.id === "O13")!.variants[1]!;
    snapshot.traceIds = ["trace-01"];
    expect(() => parsePerformanceEvidenceReport(report, "unimplemented")).toThrow(
      "cannot have traces",
    );
  });

  it("requires every declared experiment variant with trace links and a compatible tier", () => {
    const report = evidence();
    const experiment = report.experiments.find((item) => item.id === "O8")!;
    for (const variant of experiment.variants)
      Object.assign(variant, { status: "complete", missingReason: null, traceIds: ["trace-01"] });
    expect(() => assertRequiredEvidence(report, required({ experimentIds: ["O8"] }))).not.toThrow();
    experiment.variants[0]!.traceIds = [];
    expect(() => parsePerformanceEvidenceReport(report, "no-trace")).toThrow("requires traces");
  });

  it("records safe uncertainty without claiming autonomous completion", () => {
    const report = evidence();
    const crash = report.crashes[3]!;
    Object.assign(crash, {
      status: "complete",
      missingReason: null,
      recovery: "explicit-uncertainty",
      safetyPassed: true,
      taskCompleted: false,
      traceIds: ["trace-01"],
    });
    expect(() =>
      assertRequiredEvidence(report, required({ crashBoundaryIds: [crash.id] })),
    ).not.toThrow();
    crash.taskCompleted = true;
    expect(() => parsePerformanceEvidenceReport(report, "uncertain")).toThrow(
      "not task completion",
    );
  });

  it("allows a failed safety control on an incomplete crash and rejects an unmeasured pass", () => {
    const report = evidence();
    const crash = report.crashes.find((item) => item.id === "crash-03")!;
    crash.safetyPassed = false;
    expect(() => parsePerformanceEvidenceReport(report, "failed-control")).not.toThrow();
    crash.safetyPassed = true;
    expect(() => parsePerformanceEvidenceReport(report, "unmeasured-pass")).toThrow(
      "incomplete crash cannot claim",
    );
  });
});

describe("comparison contract", () => {
  it("permits a new application build while preserving suite, resources, fixtures and fixed release", () => {
    const before = evidence();
    measured(before);
    const after = structuredClone(before);
    after.build.commit = "d".repeat(40);
    after.build.parentCommit = before.build.commit;
    after.build.artifactHash = hash("candidate");
    measured(after, "m01.user-ttft", [5, 15]);
    expect(() => assertComparablePerformanceEvidence(before, after)).not.toThrow();
  });

  it.each([
    "environment",
    "fixture",
    "benchmark",
    "grader",
    "dependencyLock",
    "scenario",
    "fixedRelease",
    "coverage",
  ])("rejects incompatible %s", (change) => {
    const before = evidence();
    measured(before);
    const after = structuredClone(before);
    if (change === "environment") {
      after.environment.arch = "arm64";
      after.environmentHash = contentDigest(after.environment);
    } else if (change === "scenario") after.scenario.cacheState = "warm";
    else if (change === "fixedRelease") after.build.fixedReleaseCommit = "d".repeat(40);
    else if (change === "coverage") {
      measured(after, "m01.user-ttft", [1]);
    } else after.hashes[change as keyof typeof after.hashes] = hash("different");
    expect(() => assertComparablePerformanceEvidence(before, after)).toThrow("incompatible");
  });
});

describe("evidence integrity and counter races", () => {
  it("binds report envelopes to canonical content and detects later mutation", () => {
    const report = evidence();
    measured(report);
    const envelope = createPerformanceEvidenceEnvelope(report);
    expect(parsePerformanceEvidenceEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(
      envelope,
    );
    report.metrics[0]!.observations[0]!.value = 100;
    expect(envelope.report.metrics[0]!.observations[0]!.value).toBe(0);
    envelope.report.build.artifactHash = hash("other-build");
    expect(() => parsePerformanceEvidenceEnvelope(envelope)).toThrow("checksum");
  });

  it("rejects merged key names and commit values coerced from arrays", () => {
    const report = evidence();
    const malformed = report as unknown as Record<string, unknown>;
    delete malformed.createdAt;
    delete malformed.environment;
    malformed["createdAt,environment"] = {};
    expect(() => parsePerformanceEvidenceReport(malformed, "keys")).toThrow("exact keys");
    const another = evidence();
    Object.assign(another.build, { commit: ["a".repeat(40)] });
    expect(() => parsePerformanceEvidenceReport(another, "commit")).toThrow("commit hash");
  });

  it("rejects replayed cumulative usage under another request ID and permits a new epoch", () => {
    const report = evidence();
    const first = usage(report);
    first.counter.mode = "cumulative-difference";
    const second = structuredClone(first);
    second.requestId = "request-02";
    second.attemptId = "attempt-02";
    report.usage.push(second);
    report.usageCoverage = { expected: 2, observed: 2 };
    expect(() => parsePerformanceEvidenceReport(report, "duplicate-counter")).toThrow(
      "duplicate cumulative",
    );
    second.counter.epochId = "epoch-02";
    expect(() => parsePerformanceEvidenceReport(report, "counter-reset")).not.toThrow();
  });

  it("rejects partial input categories exceeding the logical total", () => {
    const report = evidence();
    const request = usage(report);
    request.categories.uncachedInput = known(90);
    request.categories.cacheWriteInput = unknown();
    report.usageCoverage.observed = 0;
    expect(() => parsePerformanceEvidenceReport(report, "partial-double-count")).toThrow(
      "exceed logical",
    );
  });
});

describe("independent sessions and paired evidence", () => {
  it("retains pairing without calculating confidence and rejects duplicate pair IDs", () => {
    const report = evidence();
    const metric = measured(report);
    expect(
      parsePerformanceEvidenceReport(report, "pairs").metrics[0]!.observations.map(
        ({ sessionId, pairId }) => ({ sessionId, pairId }),
      ),
    ).toEqual([
      { sessionId: "session-0", pairId: "pair-0" },
      { sessionId: "session-1", pairId: "pair-1" },
    ]);
    metric.observations[1]!.pairId = "pair-0";
    expect(() => parsePerformanceEvidenceReport(report, "duplicate-pair")).toThrow("duplicate");
    metric.observations[1]!.pairId = null;
    expect(() => parsePerformanceEvidenceReport(report, "unpaired")).not.toThrow();
  });

  it("rejects changed task fixture and grader bindings even if suite hashes are unchanged", () => {
    const before = evidence();
    const after = structuredClone(before);
    after.tasks[0]!.fixtureHash = hash("changed-task");
    expect(() => assertComparablePerformanceEvidence(before, after)).toThrow("task bindings");
    after.tasks[0]!.fixtureHash = null;
    after.tasks[0]!.graderHash = hash("changed-grader");
    expect(() => assertComparablePerformanceEvidence(before, after)).toThrow("task bindings");
  });
});

describe("pair compatibility", () => {
  it("rejects mismatched pairs without discarding either observation", () => {
    const before = evidence();
    measured(before);
    const after = structuredClone(before);
    after.metrics[0]!.observations[1]!.pairId = "pair-unmatched";
    expect(() => assertComparablePerformanceEvidence(before, after)).toThrow("measurement plan");
    expect(after.metrics[0]!.observations).toHaveLength(2);
  });
});

describe("evidence contract regressions", () => {
  it.each(CRASH_BOUNDARIES)("enforces the declared recovery for $id", ({ id, expected }) => {
    const report = evidence();
    const crash = report.crashes.find((item) => item.id === id)!;
    Object.assign(crash, {
      status: "complete",
      missingReason: null,
      recovery: expected === "automatic-recovery" ? "safe-retry" : "automatic-recovery",
      safetyPassed: true,
      taskCompleted: true,
      traceIds: ["trace-01"],
    });
    expect(() => parsePerformanceEvidenceReport(report, "wrong-recovery")).toThrow(
      "recovery does not match boundary",
    );
    expect(() => assertRequiredEvidence(report, required({ crashBoundaryIds: [id] }))).toThrow();
    crash.recovery = expected;
    crash.taskCompleted = expected !== "explicit-uncertainty";
    expect(() =>
      assertRequiredEvidence(report, required({ crashBoundaryIds: [id] })),
    ).not.toThrow();
  });

  it.each(["estimated", "virtual"] as const)(
    "retains %s usage without counting it as observed coverage",
    (kind) => {
      const report = evidence();
      const request = usage(report);
      request.categories.reasoning.provenance!.kind = kind;
      expect(() => assertRequiredEvidence(report, required({ usage: true }))).toThrow("coverage");
      report.usageCoverage.observed = 0;
      expect(parsePerformanceEvidenceReport(report, "synthetic-usage").usage).toEqual([request]);
      expect(() => assertRequiredEvidence(report, required({ usage: true }))).toThrow(
        "incomplete required usage",
      );
    },
  );

  it("requires the left commit to be a declared candidate baseline", () => {
    const before = evidence();
    const after = evidence();
    before.build.commit = "d".repeat(40);
    expect(() => assertComparablePerformanceEvidence(before, after)).toThrow(
      "undeclared comparison baseline",
    );
    before.build.commit = after.build.parentCommit;
    expect(() => assertComparablePerformanceEvidence(before, after)).not.toThrow();
    before.build.commit = after.build.fixedReleaseCommit;
    expect(() => assertComparablePerformanceEvidence(before, after)).not.toThrow();
  });

  it("validates repeated-build calibration separately from candidate comparisons", () => {
    const before = evidence();
    measured(before);
    const after = structuredClone(before);
    after.id = "calibration-repeat";
    expect(() => assertComparablePerformanceEvidence(before, after)).toThrow(
      "undeclared comparison baseline",
    );
    expect(() => assertCalibrationPerformanceEvidence(before, after)).not.toThrow();
    after.build.parentCommit = "d".repeat(40);
    expect(() => assertCalibrationPerformanceEvidence(before, after)).toThrow(
      "identical build provenance",
    );
    after.build.parentCommit = before.build.parentCommit;
    after.metrics[0]!.observations[0]!.pairId = "unrelated-pair";
    expect(() => assertCalibrationPerformanceEvidence(before, after)).toThrow("measurement plan");
  });

  it("matches task pair IDs independently of trial count and ordering", () => {
    const before = evidence();
    const task = before.tasks[0]!;
    Object.assign(task, {
      status: "complete",
      missingReason: null,
      fixtureHash: hash("task-fixture"),
      graderHash: hash("task-grader"),
      trials: ["pair-01", "pair-02", null, "null"].map((pairId, index) => ({
        id: `trial-${index}`,
        sessionId: `session-${index}`,
        pairId,
        traceId: "trace-01",
        outcome: "success",
        passed: true,
        criticalPassed: true,
        withinDeadline: true,
      })),
    });
    const after = structuredClone(before);
    after.build.parentCommit = before.build.commit;
    after.tasks[0]!.trials[0]!.pairId = "unrelated-pair";
    expect(() => assertComparablePerformanceEvidence(before, after)).toThrow("task bindings");
    after.tasks[0]!.trials[0]!.pairId = "pair-01";
    after.tasks[0]!.trials.reverse();
    expect(() => assertComparablePerformanceEvidence(before, after)).not.toThrow();
  });

  it.each(["metric", "usage"] as const)("resolves %s provenance to a declared artifact", (kind) => {
    const report = evidence();
    const value =
      kind === "metric" ? measured(report).observations[0]! : usage(report).categories.output;
    value.provenance!.sourceHash = hash("absent-source");
    expect(() => parsePerformanceEvidenceReport(report, "orphan-source")).toThrow(
      "observation source artifact missing",
    );
    report.artifacts.push({ sha256: hash("absent-source"), bytes: 1, kind: "raw" });
    expect(() => parsePerformanceEvidenceReport(report, "retained-source")).not.toThrow();
  });

  it.each(["m05.cache-token-hit", "m05.cache-request-hit"])(
    "requires live provider observations for %s",
    (id) => {
      const report = evidence();
      const metric = measured(report, id, [0, 1]);
      for (const tier of ["T0", "T1", "T2"] as const) {
        report.scenario.tier = tier;
        report.scenario.timingMode = tier === "T0" ? "virtual" : "zero-service-delay";
        report.traces[0]!.clock = tier === "T0" ? "virtual" : "monotonic";
        expect(() => parsePerformanceEvidenceReport(report, "replay-cache-hit")).toThrow(
          "cache hits require live provider evidence",
        );
      }
      report.scenario.tier = "T3";
      report.scenario.timingMode = "live";
      for (const kind of ["measured", "counted", "recorded-provider", "estimated"] as const) {
        metric.observations.forEach((item) => {
          item.provenance!.kind = kind;
        });
        expect(() => parsePerformanceEvidenceReport(report, "non-provider-cache-hit")).toThrow(
          "cache hits require live provider evidence",
        );
      }
      metric.observations.forEach((item) => {
        item.provenance!.kind = "provider-live";
      });
      expect(() => assertRequiredEvidence(report, required({ metricIds: [id] }))).not.toThrow();
    },
  );

  it("preserves replay accounting and prefix eligibility without claiming cache hits", () => {
    const report = evidence();
    usage(report);
    measured(report, "m05.prefix-eligibility", [0, 1]);
    expect(() =>
      assertRequiredEvidence(
        report,
        required({ metricIds: ["m05.prefix-eligibility"], usage: true }),
      ),
    ).not.toThrow();
    expect(() =>
      assertRequiredEvidence(report, required({ metricIds: ["m05.cache-token-hit"] })),
    ).toThrow("incomplete");
  });

  it.each(METRIC_DEFINITIONS.filter(({ familyId }) => familyId === "m10"))(
    "requires memory accounting for numeric $id observations",
    ({ id }) => {
      const report = evidence();
      const metric = measured(report, id, [0, 1000]);
      report.environment.memoryAccounting = "not-measured";
      report.environmentHash = contentDigest(report.environment);
      expect(() => parsePerformanceEvidenceReport(report, "unaccounted-memory")).toThrow(
        "memory observations require an accounting method",
      );
      metric.observations = metric.observations.map((item) => ({ ...item, ...unknown() }));
      metric.coverage.observed = 0;
      metric.missingReason = "not-measured";
      expect(() => parsePerformanceEvidenceReport(report, "unknown-memory")).not.toThrow();
      report.environment.memoryAccounting = "rss";
      report.environmentHash = contentDigest(report.environment);
      measured(report, id, [0, 1000]);
      expect(() => assertRequiredEvidence(report, required({ metricIds: [id] }))).not.toThrow();
    },
  );
});

describe("production trace fragments", () => {
  it("combines independently collected paired trials without duplicate observation IDs", () => {
    const fragments = [0, 1].map((pair) => {
      const buffer = createTraceBuffer({ processId: `worker-${pair}`, now: () => 10 });
      buffer.record(`run-${pair}`, "client.submitted", undefined, 0);
      buffer.record(`run-${pair}`, "terminal.committed", { outcome: "success" });
      return collectTraceEvidence([buffer.snapshot()], {
        sessionId: "session-1",
        pairId: `pair-${pair}`,
        requiredBoundaries: [],
      });
    });
    const report = evidence();
    report.artifacts.push(...fragments.flatMap((fragment) => fragment.artifacts));
    report.traces = fragments.flatMap((fragment) => fragment.traces);
    report.metrics = report.metrics.map((metric) => {
      const parts = fragments.flatMap((fragment) =>
        fragment.metrics.filter((part) => part.id === metric.id),
      );
      if (!parts.length) return metric;
      return {
        ...parts[0]!,
        observations: parts.flatMap((part) => part.observations),
        coverage: {
          expected: parts.length,
          observed: parts.reduce((sum, part) => sum + part.coverage.observed, 0),
        },
      };
    });
    expect(() => parsePerformanceEvidenceReport(report, "paired-trace-fragments")).not.toThrow();
  });

  it("merges measured and missing trace metrics into schema 3 without replacing its registry", () => {
    const buffer = createTraceBuffer({ processId: "fixture-worker", now: () => 10 });
    buffer.record("fixture-run", "admission.started", undefined, 0);
    buffer.record("fixture-run", "terminal.committed", { outcome: "failed" });
    const fragments = collectTraceEvidence([buffer.snapshot()], {
      sessionId: "session-1",
      pairId: "pair-1",
      expectedTraces: 1,
      requiredBoundaries: ["admission.started", "terminal.committed"],
    });
    const report = evidence();
    report.artifacts.push(...fragments.artifacts);
    report.traces = fragments.traces;
    report.metrics = report.metrics.map(
      (metric) => fragments.metrics.find((part) => part.id === metric.id) ?? metric,
    );
    expect(() => parsePerformanceEvidenceReport(report, "trace-fixture")).not.toThrow();
    expect(fragments.metrics.find((metric) => metric.id === "m01.user-ttft")!.missingReason).toBe(
      "unknown",
    );
    expect(fragments.derived[0]!.admissionToTerminal.value).toBe(10);
  });
});
