import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MetricObservation,
  PerformanceEvidenceReport,
  RequiredEvidenceSelection,
} from "../performance-report.js";
import {
  CRASH_BOUNDARIES,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  SCOREBOARD_MANIFEST,
  TASK_DEFINITIONS,
} from "./manifest.js";
import type { BudgetPolicyOptions } from "./statistics.js";
import {
  classifyInterval,
  comparePerformanceEvidence,
  createBudgetPolicy,
  freezeBudgetPolicy,
  judgeReport,
  metricBudget,
  pairedBootstrap,
  parseBudgetPolicy,
  reportRules,
} from "./statistics.js";

const digest = (label: string) => contentDigest(label);
function observations(values: number[], side = "before"): MetricObservation[] {
  return values.map((value, index) => ({
    id: `${side}-${index}`,
    sessionId: `${side}-session-${index}`,
    pairId: `pair-${index}`,
    traceId: "trace-01",
    outcome: "success",
    value,
    missingReason: null,
    provenance: { kind: "measured", sourceHash: digest("raw") },
  }));
}
function report(
  values = Array(20).fill(1000),
  metricId = "m01.user-ttft",
): PerformanceEvidenceReport {
  const environment: PerformanceEvidenceReport["environment"] = {
    platform: "linux",
    arch: "x64",
    hardwareClass: "synthetic-fixture",
    osVersion: "fixture-1",
    runtimeVersions: [{ id: "node", version: "fixture-1" }],
    containerDigests: [digest("container")],
    buildMode: "production",
    powerMode: "fixed",
    thermalState: "nominal",
    backgroundLoad: "isolated",
    memoryAccounting: "rss",
    resourceLimitsHash: digest("resources"),
    sampleIntervalMs: 1000,
  };
  return {
    schemaVersion: 3,
    id: "synthetic-report",
    createdAt: "2026-01-04T00:00:00.000Z",
    manifestHash: contentDigest(SCOREBOARD_MANIFEST),
    build: {
      commit: "a".repeat(40),
      parentCommit: "b".repeat(40),
      fixedReleaseCommit: "c".repeat(40),
      dirty: false,
      diffDigest: null,
      artifactHash: digest("build"),
    },
    hashes: {
      benchmark: digest("benchmark"),
      fixture: digest("fixture"),
      grader: digest("grader"),
      dependencyLock: digest("lock"),
    },
    environment,
    environmentHash: contentDigest(environment),
    scenario: {
      id: "synthetic-scenario",
      tier: "T1",
      comparisonMode: "controlled-harness",
      timingMode: "zero-service-delay",
      cacheState: "warm",
      loadScheduleHash: digest("load"),
      routeHash: digest("route"),
      deadlineMs: 10000,
    },
    artifacts: [
      { sha256: digest("trace"), kind: "trace", bytes: 1 },
      { sha256: digest("build"), kind: "build", bytes: 1 },
      { sha256: digest("raw"), kind: "raw", bytes: 1 },
    ],
    traces: [{ id: "trace-01", artifactHash: digest("trace"), clock: "monotonic" }],
    metrics: METRIC_DEFINITIONS.map((metric) => ({
      id: metric.id,
      unit: metric.unit,
      direction: metric.direction,
      applicability: "applicable",
      missingReason: metric.id === metricId ? null : "not-measured",
      coverage: {
        expected: metric.id === metricId ? values.length : 0,
        observed: metric.id === metricId ? values.length : 0,
      },
      observations: metric.id === metricId ? observations(values) : [],
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
const selection = (metricIds = ["m01.user-ttft"]): RequiredEvidenceSelection => ({
  metricIds,
  taskIds: [],
  experimentIds: [],
  crashBoundaryIds: [],
  usage: false,
});
const metric = (value: PerformanceEvidenceReport, id = "m01.user-ttft") =>
  value.metrics.find((item) => item.id === id)!;
const envelope = (value: PerformanceEvidenceReport) => ({
  sha256: contentDigest(value),
  report: value,
});
function setup(
  before = 1000,
  after = before,
  id = "m01.user-ttft",
  mode: "commit" | "release" = "commit",
  count = mode === "commit" ? 20 : 200,
) {
  const parent = report(Array(count).fill(before), id);
  parent.build.commit = "b".repeat(40);
  parent.build.parentCommit = "d".repeat(40);
  const candidate = report(Array(count).fill(after), id);
  const fixedRelease = structuredClone(parent);
  fixedRelease.build.commit = "c".repeat(40);
  if (id === "m05.cache-token-hit" || id === "m05.cache-request-hit")
    for (const value of [parent, candidate, fixedRelease]) {
      value.scenario.tier = "T3";
      value.scenario.timingMode = "live";
      metric(value, id).observations.forEach((item) => {
        item.provenance!.kind = "provider-live";
      });
    }
  const policy = createBudgetPolicy(selection([id]), {
    mode,
    environmentHash: parent.environmentHash,
    scenario: parent.scenario,
  });
  return { parent, candidate, fixedRelease, policy };
}
type Fixture = ReturnType<typeof setup>;
function freeze(fixture: Fixture, options: Partial<BudgetPolicyOptions> = {}) {
  const a = structuredClone(fixture.parent);
  a.createdAt = "2026-01-01T00:00:00.000Z";
  a.id = "calibration-a";
  const b = structuredClone(a);
  b.createdAt = "2026-01-02T00:00:00.000Z";
  b.id = "calibration-b";
  fixture.policy = createBudgetPolicy(fixture.policy.policy.required, {
    mode: fixture.policy.policy.mode,
    environmentHash: a.environmentHash,
    scenario: a.scenario,
    ...options,
  });
  fixture.policy = freezeBudgetPolicy(
    fixture.policy,
    [envelope(a), envelope(b)],
    "2026-01-03T00:00:00.000Z",
  );
  return fixture;
}
function compare(fixture: Fixture) {
  return comparePerformanceEvidence({
    policy: fixture.policy,
    parent: envelope(fixture.parent),
    candidate: envelope(fixture.candidate),
    fixedRelease: envelope(fixture.fixedRelease),
  });
}
const bootstrapOptions = {
  seed: 17,
  resamples: 1000,
  alpha: 0.05,
  statistic: "p50",
  direction: "lower",
} as const;

describe("paired session bootstrap", () => {
  it("returns analytically exact shifts and reverses higher-is-better degradation", () => {
    const a = observations(Array(20).fill(100));
    const b = observations(Array(20).fill(110), "after");
    expect(pairedBootstrap(a, b, bootstrapOptions).degradation).toEqual({
      value: 10,
      interval: { lower: 10, upper: 10 },
    });
    expect(
      pairedBootstrap(a, b, { ...bootstrapOptions, direction: "higher" }).degradation.interval,
    ).toEqual({ lower: -10, upper: -10 });
  });
  it("resamples paired indices, preserves correlation and ignores observation input order", () => {
    const a = observations(Array.from({ length: 20 }, (_, index) => index * 100));
    const b = observations(
      a.map((item) => item.value! + 5),
      "after",
    ).reverse();
    const result = pairedBootstrap(a, b, bootstrapOptions);
    expect(result.degradation.interval.lower).toBeCloseTo(5, 10);
    expect(result.degradation.interval.upper).toBeCloseTo(5, 10);
    expect(pairedBootstrap([...a].reverse(), [...b].reverse(), bootstrapOptions)).toEqual(result);
    const shuffled = b.map((item, index) => ({ ...item, value: index * 100 + 5 }));
    const unpairedMistake = pairedBootstrap(a, shuffled, bootstrapOptions);
    expect(
      unpairedMistake.degradation.interval.upper - unpairedMistake.degradation.interval.lower,
    ).toBeGreaterThan(100);
  });
  it("is seed-reproducible and wider under family adjustment", () => {
    const a = observations(Array(20).fill(100));
    const b = observations(
      Array.from({ length: 20 }, (_, index) => 80 + index * 5),
      "after",
    );
    const standard = pairedBootstrap(a, b, { ...bootstrapOptions, resamples: 10000 });
    expect(pairedBootstrap(a, b, { ...bootstrapOptions, resamples: 10000 })).toEqual(standard);
    const adjusted = pairedBootstrap(a, b, { ...bootstrapOptions, resamples: 10000, alpha: 0.005 });
    expect(adjusted.degradation.interval.lower).toBeLessThanOrEqual(
      standard.degradation.interval.lower,
    );
    expect(adjusted.degradation.interval.upper).toBeGreaterThanOrEqual(
      standard.degradation.interval.upper,
    );
  });
  it("keeps nested observations in their session and rejects many-to-one session pairing", () => {
    const a = observations(Array(40).fill(100)).map((item, index) => ({
      ...item,
      sessionId: `before-${Math.floor(index / 20)}`,
    }));
    const b = observations(Array(40).fill(110), "after").map((item, index) => ({
      ...item,
      sessionId: `after-${Math.floor(index / 20)}`,
    }));
    expect(pairedBootstrap(a, b, bootstrapOptions).independentPairs).toBe(2);
    b[0]!.sessionId = "after-1";
    expect(() => pairedBootstrap(a, b, bootstrapOptions)).toThrow("incompatible-session-pairing");
  });
  it.each([NaN, Infinity, -1, null])("rejects invalid raw values %s", (value) => {
    const a = observations([1]);
    a[0]!.value = value;
    expect(() => pairedBootstrap(a, observations([1]), bootstrapOptions)).toThrow(
      "invalid-paired-value",
    );
  });
  it("rejects empty, missing, duplicated and unmatched pairs", () => {
    expect(() => pairedBootstrap([], [], bootstrapOptions)).toThrow("pair-count");
    const a = observations([1, 2]);
    const b = observations([1, 2]);
    b[0]!.pairId = null;
    expect(() => pairedBootstrap(a, b, bootstrapOptions)).toThrow("missing-pair");
    b[0]!.pairId = b[1]!.pairId;
    expect(() => pairedBootstrap(a, b, bootstrapOptions)).toThrow("duplicate-pair");
    b[0]!.pairId = "unmatched";
    expect(() => pairedBootstrap(a, b, bootstrapOptions)).toThrow("unmatched-pair");
  });
  it("does not mistake a difference of p95s for p95 of per-trace overhead", () => {
    const a = observations([0, 100]);
    const b = observations([100, 100]);
    const result = pairedBootstrap(a, b, { ...bootstrapOptions, statistic: "p95" });
    expect(result.degradation.value).toBe(5);
    const overhead = pairedBootstrap(observations([0, 0]), observations([100, 0]), {
      ...bootstrapOptions,
      statistic: "p95",
    });
    expect(overhead.after.value).toBe(95);
  });
  it("rejects unresolved extreme bootstrap tails", () => {
    expect(() =>
      pairedBootstrap(observations([1]), observations([1]), { ...bootstrapOptions, alpha: 0.0001 }),
    ).toThrow("tail-resolution");
  });
});

describe("verdict boundaries", () => {
  it.each([
    [-10, -1, 25, "improved"],
    [-1, 0, 25, "within-budget"],
    [0, 25, 25, "within-budget"],
    [25, 26, 25, "inconclusive"],
    [24, 26, 25, "inconclusive"],
    [26, 30, 25, "regressed"],
  ] as const)("classifies [%s, %s] against %s as %s", (lower, upper, margin, expected) => {
    expect(classifyInterval({ lower, upper }, margin)).toBe(expected);
  });
  it("rejects malformed intervals", () => {
    expect(() => classifyInterval({ lower: 10, upper: 1 }, 5)).toThrow();
    expect(() => classifyInterval({ lower: 0, upper: Infinity }, 5)).toThrow();
  });
});

describe("retained budget specification", () => {
  it.each([
    ["m01.user-ttft", 0.1, 25],
    ["m04.logical-input", 0.05, 128],
    ["m05.cache-token-hit", 0, 0.05],
    ["m10.idle-footprint", 0.1, 33554432],
    ["m10.peak-footprint", 0.15, 67108864],
    ["m11.initial-js-gzip", 0, 10240],
    ["m11.installer", 0.05, 0],
    ["m14.task-energy", 0.1, 0],
  ])("retains %s margins", (id, relative, absolute) => {
    const fixture = setup(1, 1, id as string, "release");
    expect(
      metricBudget(METRIC_DEFINITIONS.find((item) => item.id === id)!, fixture.policy.policy),
    ).toMatchObject({ relative, absolute });
  });
  it.each([
    ["m01.acknowledgement", 100],
    ["m01.safe-to-paint", 50],
    ["m08.eligible-to-lease", 250],
    ["m13.cancellation-acknowledgement", 1000],
  ])("retains absolute p95 target %s", (id, target) => {
    const fixture = setup(1, 1, id as string);
    fixture.policy.policy.declarations.nominalQueue = true;
    expect(
      metricBudget(METRIC_DEFINITIONS.find((item) => item.id === id)!, fixture.policy.policy)
        .absoluteP95,
    ).toBe(target);
  });
  it("warns strictly above both commit thresholds", () => {
    expect(compare(setup(1000, 1050)).status).toBe("pass");
    expect(compare(setup(1000, 1051)).status).toBe("regression");
    expect(compare(setup(100, 125)).status).toBe("pass");
    expect(compare(setup(100, 126)).status).toBe("regression");
  });
  it("enforces both release tolerances and exact boundaries", () => {
    expect(compare(freeze(setup(1000, 1100, "m01.user-ttft", "release"))).status).toBe("pass");
    expect(compare(freeze(setup(100, 125, "m01.user-ttft", "release"))).status).toBe("pass");
    expect(compare(freeze(setup(1000, 1101, "m01.user-ttft", "release"))).exitCode).toBe(1);
  });
  it("never lets repeated small changes evade the fixed release", () => {
    const fixture = freeze(setup(1100, 1150, "m01.user-ttft", "release"));
    metric(fixture.fixedRelease).observations.forEach((item) => {
      item.value = 1000;
    });
    const verdict = compare(fixture);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.comparisons.find((item) => item.baseline === "parent")!.verdict).toBe(
      "within-budget",
    );
    expect(verdict.comparisons.find((item) => item.baseline === "fixed-release")!.verdict).toBe(
      "regressed",
    );
  });
  it("detects higher-is-better warm cache losses in percentage points", () => {
    expect(compare(freeze(setup(0.8, 0.75, "m05.cache-token-hit", "release"))).status).toBe("pass");
    expect(compare(freeze(setup(0.8, 0.76, "m05.cache-token-hit", "release"))).status).toBe("pass");
    expect(compare(freeze(setup(0.8, 0.74, "m05.cache-token-hit", "release"))).status).toBe(
      "regression",
    );
  });
  it("does not let relative improvements hide an absolute target miss", () => {
    const fixture = setup(150, 120, "m01.acknowledgement");
    const verdict = compare(fixture);
    expect(verdict.exitCode).toBe(1);
    expect(
      verdict.comparisons.some(
        (item) => item.verdict === "improved" && item.absoluteVerdict === "regressed",
      ),
    ).toBe(true);
  });
  it("requires separately declared Stop and retained-session envelopes", () => {
    expect(compare(setup(0, 0, "m10.post-idle-retained")).exitCode).toBe(2);
    expect(
      compare(setup(100, 100, "m13.terminal-stop")).reasons.some(
        (item) => item.code === "undeclared-budget",
      ),
    ).toBe(true);
  });
});

describe("evidence and calibration", () => {
  it("keeps proposed release policy incomplete, even with passing intervals", () => {
    const result = compare(setup(1000, 1000, "m01.user-ttft", "release"));
    expect(result.exitCode).toBe(2);
    expect(result.reasons.some((item) => item.code === "calibration-required")).toBe(true);
    expect(result.releaseEligible).toBe(false);
    expect(compare(freeze(setup())).releaseEligible).toBe(false);
    expect(compare(freeze(setup(1000, 1000, "m01.user-ttft", "release"))).releaseEligible).toBe(
      true,
    );
  });
  it("freezes exact configuration with A/A evidence and rejects mutations", () => {
    const fixture = freeze(setup(1000, 1000, "m01.user-ttft", "release"));
    expect(compare(fixture).exitCode).toBe(0);
    const policy = structuredClone(fixture.policy);
    policy.policy.analysis.seed++;
    expect(() => parseBudgetPolicy(policy)).toThrow("policy-checksum");
    policy.sha256 = contentDigest(policy.policy);
    policy.policy.gates.latency.releaseRelative = 0.9;
    policy.sha256 = contentDigest(policy.policy);
    expect(() => parseBudgetPolicy(policy)).toThrow("modified-policy");
    expect(() => freezeBudgetPolicy(fixture.policy, [], "2026-01-03T00:00:00.000Z")).toThrow(
      "already-frozen",
    );
  });
  it("rejects candidate evaluation preceding freeze", () => {
    const fixture = freeze(setup());
    fixture.candidate.createdAt = "2026-01-02T00:00:00.000Z";
    expect(
      compare(fixture).reasons.some((item) => item.code === "candidate-before-policy-freeze"),
    ).toBe(true);
  });
  it("rejects duplicate, dirty, late and different-build calibration", () => {
    const fixture = setup();
    const a = structuredClone(fixture.parent);
    a.createdAt = "2026-01-01T00:00:00.000Z";
    const b = structuredClone(a);
    b.id = "other";
    expect(() =>
      freezeBudgetPolicy(fixture.policy, [envelope(a), envelope(a)], "2026-01-03T00:00:00.000Z"),
    ).toThrow("duplicate");
    b.build.commit = "d".repeat(40);
    expect(() =>
      freezeBudgetPolicy(fixture.policy, [envelope(a), envelope(b)], "2026-01-03T00:00:00.000Z"),
    ).toThrow("same-build");
    b.build.commit = a.build.commit;
    b.createdAt = "2026-01-04T00:00:00.000Z";
    expect(() =>
      freezeBudgetPolicy(fixture.policy, [envelope(a), envelope(b)], "2026-01-03T00:00:00.000Z"),
    ).toThrow("after-freeze");
    b.createdAt = a.createdAt;
    b.build.dirty = true;
    b.build.diffDigest = digest("dirty");
    expect(() =>
      freezeBudgetPolicy(fixture.policy, [envelope(a), envelope(b)], "2026-01-03T00:00:00.000Z"),
    ).toThrow("dirty");
  });
  it("does not calibrate away observed noise exceeding the retained budget", () => {
    const fixture = setup();
    const a = structuredClone(fixture.parent);
    const b = structuredClone(a);
    a.createdAt = "2026-01-01T00:00:00.000Z";
    b.createdAt = "2026-01-02T00:00:00.000Z";
    metric(b).observations.forEach((item) => {
      item.value = 1400;
    });
    expect(() =>
      freezeBudgetPolicy(fixture.policy, [envelope(a), envelope(b)], "2026-01-03T00:00:00.000Z"),
    ).toThrow("outside-budget");
  });
  it("allocates confidence across predeclared family members, statistics, strata and both baselines", () => {
    const one = setup();
    const ordinary = compare(one).comparisons[0]!.estimate!.alpha;
    const two = setup();
    for (const value of [two.parent, two.candidate, two.fixedRelease]) {
      Object.assign(metric(value, "m01.useful-activity"), {
        ...metric(value),
        id: "m01.useful-activity",
      });
    }
    two.policy = createBudgetPolicy(selection(["m01.user-ttft", "m01.useful-activity"]), {
      mode: "commit",
      environmentHash: two.parent.environmentHash,
      scenario: two.parent.scenario,
      resamples: 40000,
    });
    const result = compare(two);
    expect(result.exitCode).toBe(0);
    expect(result.comparisons[0]!.estimate!.alpha).toBeCloseTo(ordinary / 2, 12);
    expect(result.evidence!.candidate.report.metrics).toEqual(two.candidate.metrics);
  });
  it.each([
    [
      "wrong units",
      (r: PerformanceEvidenceReport) => {
        metric(r).unit = "bytes";
      },
    ],
    [
      "wrong direction",
      (r: PerformanceEvidenceReport) => {
        metric(r).direction = "higher";
      },
    ],
    [
      "negative",
      (r: PerformanceEvidenceReport) => {
        metric(r).observations[0]!.value = -1;
      },
    ],
    [
      "missing key",
      (r: PerformanceEvidenceReport) => {
        r.metrics.pop();
      },
    ],
    [
      "extra key",
      (r: PerformanceEvidenceReport) => {
        r.metrics.push({ ...metric(r), id: "unknown" });
      },
    ],
    [
      "missing coverage",
      (r: PerformanceEvidenceReport) => {
        metric(r).coverage.expected++;
      },
    ],
    [
      "dirty artifact",
      (r: PerformanceEvidenceReport) => {
        r.build.dirty = true;
        r.build.diffDigest = digest("diff");
      },
    ],
    [
      "wrong parent",
      (r: PerformanceEvidenceReport) => {
        r.build.parentCommit = "d".repeat(40);
      },
    ],
    [
      "build provenance",
      (r: PerformanceEvidenceReport) => {
        r.artifacts = r.artifacts.filter((item) => item.kind !== "build");
      },
    ],
    [
      "raw provenance",
      (r: PerformanceEvidenceReport) => {
        r.artifacts = r.artifacts.filter((item) => item.kind !== "raw");
      },
    ],
    [
      "environment",
      (r: PerformanceEvidenceReport) => {
        r.environment.powerMode = "changed";
        r.environmentHash = contentDigest(r.environment);
      },
    ],
    [
      "scenario",
      (r: PerformanceEvidenceReport) => {
        r.scenario.cacheState = "cold";
      },
    ],
    [
      "fixture hash",
      (r: PerformanceEvidenceReport) => {
        r.hashes.fixture = digest("changed");
      },
    ],
    [
      "unknown observation",
      (r: PerformanceEvidenceReport) => {
        const observation = metric(r).observations[0]!;
        observation.value = null;
        observation.missingReason = "provider-omitted";
        observation.provenance = null;
        metric(r).coverage.observed--;
        metric(r).missingReason = "provider-omitted";
      },
    ],
    [
      "estimated",
      (r: PerformanceEvidenceReport) => {
        metric(r).observations[0]!.provenance!.kind = "estimated";
      },
    ],
    [
      "recorded timing",
      (r: PerformanceEvidenceReport) => {
        metric(r).observations[0]!.provenance!.kind = "recorded-provider";
      },
    ],
    [
      "missing pair",
      (r: PerformanceEvidenceReport) => {
        metric(r).observations[0]!.pairId = null;
      },
    ],
  ])("classifies %s as incomplete", (_, mutate) => {
    const fixture = setup();
    (mutate as (r: PerformanceEvidenceReport) => void)(fixture.candidate);
    expect(compare(fixture).exitCode).toBe(2);
  });
  it("does not drop failed, cancelled, slow or uncertain samples", () => {
    const fixture = setup();
    metric(fixture.candidate).observations[0]!.outcome = "failed";
    expect(compare(fixture).reasons.some((item) => item.code === "outcome-pairing-changed")).toBe(
      true,
    );
    for (const outcome of ["failed", "cancelled", "timed-out", "uncertain"] as const) {
      const equal = setup();
      for (const value of [equal.parent, equal.candidate, equal.fixedRelease])
        metric(value).observations.forEach((item) => {
          item.outcome = outcome;
        });
      const result = compare(equal);
      expect(
        result.evidence!.candidate.report.metrics.find((item) => item.id === "m01.user-ttft")!
          .observations,
      ).toHaveLength(20);
      expect(result.comparisons.some((item) => item.outcome === outcome)).toBe(true);
    }
  });
  it("requires 20 independent commit pairs, 200 replay pairs and 100 startup pairs", () => {
    expect(compare(setup(1000, 1000, "m01.user-ttft", "commit", 19)).exitCode).toBe(2);
    expect(() => freeze(setup(1000, 1000, "m01.user-ttft", "release", 199))).toThrow("incomplete");
    const startup = setup(1000, 1000, "m09.usable-shell", "release", 100);
    for (const value of [startup.parent, startup.candidate, startup.fixedRelease])
      value.scenario.tier = "T2";
    expect(compare(freeze(startup)).exitCode).toBe(0);
    const correlated = setup();
    for (const value of [correlated.parent, correlated.candidate, correlated.fixedRelease])
      metric(value).observations.forEach((item) => {
        item.sessionId = "one-session";
      });
    expect(compare(correlated).exitCode).toBe(2);
  });
  it("never passes an interval overlapping the release margin", () => {
    const fixture = freeze(setup(1000, 1000, "m01.user-ttft", "release"));
    metric(fixture.candidate).observations = observations(
      Array.from({ length: 200 }, (_, index) => (index % 2 ? 1250 : 950)),
      "after",
    );
    const result = compare(fixture);
    expect(result.status).not.toBe("pass");
    expect(result.comparisons.some((item) => item.verdict === "inconclusive")).toBe(true);
  });
  it("preserves legitimate zero event counts and immediately blocks safety failures", () => {
    expect(compare(setup(0, 0, "m13.wrong-pin", "commit", 1)).exitCode).toBe(0);
    const fixture = setup(1000, 900);
    const safety = metric(fixture.candidate, "m13.wrong-pin");
    safety.observations = observations([1]);
    safety.coverage = { expected: 1, observed: 1 };
    safety.missingReason = null;
    const result = compare(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.reasons.some((item) => item.code === "safety-failure")).toBe(true);
  });
  it("judges a caller-supplied effect-safety list and completed pinned crashes", () => {
    const fixture = report();
    const none = selection([]);
    const outside = metric(fixture, "m01.user-ttft");
    outside.observations = observations([1]);
    outside.missingReason = null;
    expect(judgeReport(fixture, none).some((item) => item.scope === "m01.user-ttft")).toBe(false);
    expect(
      judgeReport(fixture, none, { effectMetricIds: ["m01.user-ttft", "m99.added-effect"] }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "safety-failure", scope: "m01.user-ttft" }),
        expect.objectContaining({ code: "safety-failure", scope: "m99.added-effect" }),
      ]),
    );
    const crash = fixture.crashes[0]!;
    const expected = CRASH_BOUNDARIES.find((item) => item.id === crash.id)!.expected;
    crash.status = "complete";
    crash.missingReason = null;
    crash.recovery = expected;
    crash.safetyPassed = null;
    expect(judgeReport(fixture, none).some((item) => item.scope === crash.id)).toBe(false);
    expect(
      judgeReport(fixture, { ...none, crashBoundaryIds: [crash.id] }).some(
        (item) => item.code === "safety-failure" && item.scope === crash.id,
      ),
    ).toBe(true);
  });
  it("fails a required task on its trial result even when its critical checks pass", () => {
    const fixture = report();
    Object.assign(fixture.tasks[0]!, {
      status: "complete",
      missingReason: null,
      fixtureHash: digest("task-fixture"),
      graderHash: digest("task-grader"),
      trials: [
        {
          id: "trial-01",
          sessionId: "task-session",
          pairId: "task-pair",
          traceId: "trace-01",
          outcome: "success",
          passed: false,
          criticalPassed: true,
          withinDeadline: true,
        },
      ],
    });
    const taskId = fixture.tasks[0]!.id;
    expect(judgeReport(fixture, { ...selection([]), taskIds: [taskId] })).toEqual([
      { code: "required-task-failed", scope: taskId, detail: "required-task-failed" },
    ]);
    expect(judgeReport(fixture, selection([]))).toEqual([]);
  });
  it("names the rule that decides each selected item", () => {
    expect(
      reportRules({
        metricIds: ["m13.wrong-pin", "m04.logical-input"],
        taskIds: ["task-01"],
        experimentIds: ["O12"],
        crashBoundaryIds: ["crash-01"],
        usage: true,
      }),
    ).toEqual([
      { id: "m13.wrong-pin", rule: "effect-count" },
      { id: "m04.logical-input", rule: "baseline-budget" },
      { id: "task-01", rule: "task-pass" },
      { id: "crash-01", rule: "crash-safety" },
      { id: "O12", rule: null },
      { id: "usage", rule: "measured-usage" },
    ]);
  });
  it("blocks critical compaction fact loss and failed required tasks even with improved timing", () => {
    const fixture = setup(1000, 900);
    for (const value of [fixture.parent, fixture.candidate, fixture.fixedRelease]) {
      Object.assign(value.tasks[0]!, {
        status: "complete",
        missingReason: null,
        fixtureHash: digest("task-fixture"),
        graderHash: digest("task-grader"),
        trials: [
          {
            id: "trial-01",
            sessionId: "task-session",
            pairId: "task-pair",
            traceId: "trace-01",
            outcome: "success",
            passed: true,
            criticalPassed: true,
            withinDeadline: true,
          },
        ],
      });
    }
    const required = selection();
    required.taskIds = ["task-01"];
    fixture.policy = createBudgetPolicy(required, {
      mode: "commit",
      environmentHash: fixture.parent.environmentHash,
      scenario: fixture.parent.scenario,
    });
    fixture.candidate.tasks[0]!.trials[0]!.passed = false;
    expect(compare(fixture).reasons.some((item) => item.code === "required-task-failed")).toBe(
      true,
    );
    fixture.candidate.tasks[0]!.trials[0]!.criticalPassed = false;
    expect(compare(fixture).reasons.some((item) => item.code === "safety-failure")).toBe(true);
  });
  it("blocks invalid recovery transitions and preserves safe uncertainty as distinct from completion", () => {
    const fixture = setup();
    Object.assign(fixture.candidate.crashes[3]!, {
      status: "complete",
      missingReason: null,
      recovery: "safe-retry",
      safetyPassed: true,
      taskCompleted: true,
      traceIds: ["trace-01"],
    });
    expect(compare(fixture).exitCode).toBe(2);
    fixture.candidate.crashes[3]!.recovery = "explicit-uncertainty";
    fixture.candidate.crashes[3]!.taskCompleted = false;
    expect(compare(fixture).reasons.some((item) => item.code === "safety-failure")).toBe(false);
    const incompleteControl = setup();
    const crash = incompleteControl.candidate.crashes.find((item) => item.id === "crash-03")!;
    crash.safetyPassed = false;
    const blocked = compare(incompleteControl);
    expect(blocked.exitCode).toBe(1);
    expect(
      blocked.reasons.some((item) => item.code === "safety-failure" && item.scope === "crash-03"),
    ).toBe(true);
    expect(compare(fixture).evidence!.candidate.report.crashes[3]!.taskCompleted).toBe(false);
  });
  it("requires actual memory accounting and required energy coverage", () => {
    const memory = setup(1000, 1000, "m10.idle-footprint");
    for (const value of [memory.parent, memory.candidate, memory.fixedRelease]) {
      value.environment.memoryAccounting = "not-measured";
      value.environmentHash = contentDigest(value.environment);
    }
    memory.policy = createBudgetPolicy(selection(["m10.idle-footprint"]), {
      mode: "commit",
      environmentHash: memory.parent.environmentHash,
      scenario: memory.parent.scenario,
    });
    expect(compare(memory).exitCode).toBe(2);
    const energy = setup();
    energy.policy = createBudgetPolicy(selection(["m01.user-ttft", "m14.task-energy"]), {
      mode: "commit",
      environmentHash: energy.parent.environmentHash,
      scenario: energy.parent.scenario,
    });
    expect(compare(energy).exitCode).toBe(2);
  });
  it("checks caller mutation and damaged report checksums at evaluation time", () => {
    const fixture = freeze(setup());
    const candidate = envelope(fixture.candidate);
    metric(candidate.report).observations[0]!.value = 900;
    const result = comparePerformanceEvidence({
      policy: fixture.policy,
      parent: envelope(fixture.parent),
      candidate,
      fixedRelease: envelope(fixture.fixedRelease),
    });
    expect(result.exitCode).toBe(2);
    fixture.policy.policy.calibration!.reports[0]!.report.createdAt = "2026-01-05T00:00:00.000Z";
    expect(compare(fixture).exitCode).toBe(2);
  });
  it("rejects zero sample counts, unknown required coverage and T0 timing", () => {
    const fixture = setup();
    for (const value of [fixture.parent, fixture.candidate, fixture.fixedRelease]) {
      metric(value).observations = [];
      metric(value).coverage = { expected: 0, observed: 0 };
      metric(value).missingReason = "not-measured";
    }
    expect(compare(fixture).exitCode).toBe(2);
    expect(() =>
      createBudgetPolicy(selection(["missing"]), {
        mode: "commit",
        environmentHash: fixture.parent.environmentHash,
        scenario: fixture.parent.scenario,
      }),
    ).toThrow("unknown");
    const virtual = setup();
    for (const value of [virtual.parent, virtual.candidate, virtual.fixedRelease]) {
      value.scenario.tier = "T0";
      value.scenario.timingMode = "virtual";
      value.traces[0]!.clock = "virtual";
    }
    expect(compare(virtual).exitCode).toBe(2);
  });
});

describe("plain Node CLI integration", () => {
  it("returns separate pass, regression and incomplete codes with valid JSON and retained raw evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "verdict-fixture-"));
    try {
      for (const [fixture, code] of [
        [freeze(setup()), 0],
        [freeze(setup(1000, 1400)), 1],
        [setup(1000, 1000, "m01.user-ttft", "release"), 2],
      ] as const) {
        const files = ["parent", "candidate", "fixed", "policy"].map((name) =>
          path.join(directory, `${name}.json`),
        );
        await Promise.all(
          [
            envelope(fixture.parent),
            envelope(fixture.candidate),
            envelope(fixture.fixedRelease),
            fixture.policy,
          ].map((value, index) => writeFile(files[index]!, JSON.stringify(value))),
        );
        const result = spawnSync(process.execPath, ["scripts/performance-budget.mjs", ...files], {
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(code);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.exitCode).toBe(code);
        expect(parsed.evidence.candidate.sha256).toBe(contentDigest(fixture.candidate));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not leak paths or throw for missing input files", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/performance-budget.mjs", "does-not-exist", "also-absent"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).reasons[0].code).toBe("invalid-input");
    expect(result.stdout).not.toContain(process.cwd());
  });
});
