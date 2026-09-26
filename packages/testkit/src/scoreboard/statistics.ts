import type {
  EvidenceOutcome,
  MetricObservation,
  PerformanceEvidenceEnvelope,
  PerformanceEvidenceReport,
  RequiredEvidenceSelection,
} from "../performance-report.js";
import {
  assertCalibrationPerformanceEvidence,
  assertComparablePerformanceEvidence,
  assertRequiredEvidence,
  parsePerformanceEvidenceEnvelope,
} from "../performance-report.js";
import type { MetricDefinition } from "./manifest.js";
import {
  CRASH_BOUNDARIES,
  canonicalSerialize,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  SCOREBOARD_MANIFEST,
  TASK_DEFINITIONS,
} from "./manifest.js";

export const PERFORMANCE_EXIT_CODES = Object.freeze({ pass: 0, regression: 1, incomplete: 2 });
export type StatisticalVerdict = "improved" | "within-budget" | "regressed" | "inconclusive";
export type Statistic = "p50" | "p95";
export interface Interval {
  lower: number;
  upper: number;
}
export interface Estimate {
  value: number;
  interval: Interval;
}
export interface PairedEstimate {
  before: Estimate;
  after: Estimate;
  degradation: Estimate;
  samplePairs: number;
  independentPairs: number;
  alpha: number;
}
export interface AnalysisOptions {
  seed: number;
  resamples: number;
  alpha: number;
  statistic: Statistic;
  direction: "lower" | "higher";
}
const OUTCOMES: EvidenceOutcome[] = ["success", "failed", "cancelled", "timed-out", "uncertain"];
const GATES = SCOREBOARD_MANIFEST.proposedGates;
/** The effect-safety counts judged when a caller does not pin its own list. */
export const SAFETY_METRICS: readonly string[] = [
  "m13.wrong-pin",
  "m13.unauthorized-effects",
  "m13.duplicate-effects",
  "m13.lost-accepted-work",
  "m13.false-completion",
  "m11.lazy-boundary-violations",
];

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[Math.ceil(position)]! * weight;
}
function interval(values: number[], alpha: number): Interval {
  return { lower: quantile(values, alpha / 2), upper: quantile(values, 1 - alpha / 2) };
}
function randomGenerator(seed: number) {
  let state = seed >>> 0;
  // Mulberry32 is an analysis PRNG, never a source of security tokens.
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pair by identity, then resample whole independent sessions, never individual nested events. */
function pairedSessions(before: MetricObservation[], after: MetricObservation[]) {
  requireCondition(before.length > 0 && before.length === after.length, "pair-count-mismatch");
  const indexed = (observations: MetricObservation[]) => {
    const map = new Map<string, MetricObservation>();
    for (const observation of observations) {
      requireCondition(
        typeof observation.pairId === "string" && observation.pairId.length > 0,
        "missing-pair-id",
      );
      requireCondition(
        typeof observation.sessionId === "string" && observation.sessionId.length > 0,
        "missing-session-id",
      );
      requireCondition(!map.has(observation.pairId), "duplicate-pair-id");
      requireCondition(
        typeof observation.value === "number" &&
          Number.isFinite(observation.value) &&
          observation.value >= 0,
        "invalid-paired-value",
      );
      map.set(observation.pairId, observation);
    }
    return map;
  };
  const left = indexed(before);
  const right = indexed(after);
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const groups = new Map<string, { before: number[]; after: number[] }>();
  for (const pairId of [...left.keys()].sort()) {
    const a = left.get(pairId)!;
    const b = right.get(pairId);
    requireCondition(b, "unmatched-pair-id");
    requireCondition(
      (!forward.has(a.sessionId) || forward.get(a.sessionId) === b.sessionId) &&
        (!reverse.has(b.sessionId) || reverse.get(b.sessionId) === a.sessionId),
      "incompatible-session-pairing",
    );
    forward.set(a.sessionId, b.sessionId);
    reverse.set(b.sessionId, a.sessionId);
    const group = groups.get(a.sessionId) ?? { before: [], after: [] };
    group.before.push(a.value!);
    group.after.push(b.value!);
    groups.set(a.sessionId, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => group);
}

/** Percentile bootstrap of a distribution shift. This is not a derived overhead duration. */
export function pairedBootstrap(
  before: MetricObservation[],
  after: MetricObservation[],
  options: AnalysisOptions,
): PairedEstimate {
  requireCondition(
    Number.isInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffffffff,
    "invalid-seed",
  );
  requireCondition(
    Number.isInteger(options.resamples) &&
      options.resamples >= 1000 &&
      options.resamples <= 1_000_000,
    "invalid-resamples",
  );
  requireCondition(
    Number.isFinite(options.alpha) && options.alpha > 0 && options.alpha < 1,
    "invalid-alpha",
  );
  requireCondition(
    (options.resamples * options.alpha) / 2 >= 10,
    "insufficient-bootstrap-tail-resolution",
  );
  requireCondition(options.statistic === "p50" || options.statistic === "p95", "invalid-statistic");
  requireCondition(
    options.direction === "lower" || options.direction === "higher",
    "invalid-direction",
  );
  const groups = pairedSessions(before, after);
  const probability = options.statistic === "p50" ? 0.5 : 0.95;
  const sign = options.direction === "lower" ? 1 : -1;
  const left = groups.flatMap((group) => group.before);
  const right = groups.flatMap((group) => group.after);
  const baseline = quantile(left, probability);
  const candidate = quantile(right, probability);
  const leftSamples: number[] = [];
  const rightSamples: number[] = [];
  const differences: number[] = [];
  const random = randomGenerator(options.seed);
  const constant =
    left.every((value) => value === left[0]) && right.every((value) => value === right[0]);
  for (let index = 0; index < (constant ? 1 : options.resamples); index++) {
    const a: number[] = [];
    const b: number[] = [];
    for (let session = 0; session < groups.length; session++) {
      const group = groups[Math.floor(random() * groups.length)]!;
      a.push(...group.before);
      b.push(...group.after);
    }
    const x = quantile(a, probability);
    const y = quantile(b, probability);
    leftSamples.push(x);
    rightSamples.push(y);
    differences.push(sign * (y - x));
  }
  requireCondition(
    [...leftSamples, ...rightSamples, ...differences].every(Number.isFinite),
    "numeric-overflow",
  );
  return {
    before: { value: baseline, interval: interval(leftSamples, options.alpha) },
    after: { value: candidate, interval: interval(rightSamples, options.alpha) },
    degradation: {
      value: sign * (candidate - baseline),
      interval: interval(differences, options.alpha),
    },
    samplePairs: left.length,
    independentPairs: groups.length,
    alpha: options.alpha,
  };
}

export function classifyInterval(bounds: Interval, margin: number): StatisticalVerdict {
  requireCondition(
    Number.isFinite(margin) &&
      margin >= 0 &&
      Number.isFinite(bounds.lower) &&
      Number.isFinite(bounds.upper) &&
      bounds.lower <= bounds.upper,
    "invalid-interval",
  );
  if (exceeds(bounds.lower, margin)) return "regressed";
  if (exceeds(bounds.upper, margin)) return "inconclusive";
  return exceeds(0, bounds.upper) ? "improved" : "within-budget";
}

// Absorb arithmetic roundoff at an exact boundary, not measurement uncertainty.
function exceeds(value: number, boundary: number) {
  return value - boundary > 4 * Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(boundary));
}

export interface BudgetPolicyOptions {
  mode: "commit" | "release";
  environmentHash: string;
  scenario: PerformanceEvidenceReport["scenario"];
  seed?: number;
  resamples?: number;
  nominalQueue?: boolean;
  retainedSessionGrowthBytes?: number | null;
  toolTerminationDeadlineMs?: number | null;
}
export interface BudgetPolicy {
  schemaVersion: 1;
  manifestHash: string;
  mode: "commit" | "release";
  environmentHash: string;
  scenario: PerformanceEvidenceReport["scenario"];
  required: RequiredEvidenceSelection;
  familyIds: string[];
  analysis: {
    method: "paired-session-percentile";
    adjustment: "bonferroni";
    confidence: 0.95;
    seed: number;
    resamples: number;
    outcomes: EvidenceOutcome[];
  };
  declarations: {
    nominalQueue: boolean;
    retainedSessionGrowthBytes: number | null;
    toolTerminationDeadlineMs: number | null;
  };
  gates: typeof GATES;
  calibration: { frozenAt: string; reports: PerformanceEvidenceEnvelope[] } | null;
}
export interface BudgetPolicyEnvelope {
  sha256: string;
  policy: BudgetPolicy;
}

/** Proposed values are taken from W0-1 verbatim. No candidate-driven threshold overrides. */
export function createBudgetPolicy(
  required: RequiredEvidenceSelection,
  options: BudgetPolicyOptions,
): BudgetPolicyEnvelope {
  requireCondition(options.mode === "commit" || options.mode === "release", "invalid-policy-mode");
  requireCondition(/^[a-f0-9]{64}$/.test(options.environmentHash), "invalid-policy-environment");
  requireCondition(
    Object.keys(required).sort().join(",") ===
      "crashBoundaryIds,experimentIds,metricIds,taskIds,usage",
    "invalid-required-selection",
  );
  for (const [ids, definitions] of [
    [required.metricIds, METRIC_DEFINITIONS],
    [required.taskIds, TASK_DEFINITIONS],
    [required.experimentIds, EXPERIMENT_DEFINITIONS],
    [required.crashBoundaryIds, CRASH_BOUNDARIES],
  ] as const) {
    requireCondition(
      Array.isArray(ids) &&
        new Set(ids).size === ids.length &&
        ids.every((id) => definitions.some((item) => item.id === id)),
      "unknown-or-duplicate-required-definition",
    );
  }
  requireCondition(typeof required.usage === "boolean", "invalid-usage-requirement");
  requireCondition(
    required.metricIds.length +
      required.taskIds.length +
      required.experimentIds.length +
      required.crashBoundaryIds.length >
      0 || required.usage,
    "empty-required-selection",
  );
  const seed = options.seed ?? 0x51c0ab1e;
  const resamples = options.resamples ?? 20_000;
  requireCondition(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, "invalid-seed");
  requireCondition(
    Number.isInteger(resamples) && resamples >= 1000 && resamples <= 1_000_000,
    "invalid-resamples",
  );
  for (const value of [options.retainedSessionGrowthBytes, options.toolTerminationDeadlineMs])
    requireCondition(
      value == null || (Number.isFinite(value) && value >= 0),
      "invalid-declared-envelope",
    );
  requireCondition(
    options.nominalQueue === undefined || typeof options.nominalQueue === "boolean",
    "invalid-nominal-queue",
  );
  const policy: BudgetPolicy = {
    schemaVersion: 1,
    manifestHash: contentDigest(SCOREBOARD_MANIFEST),
    mode: options.mode,
    environmentHash: options.environmentHash,
    scenario: options.scenario,
    required,
    familyIds: [
      ...new Set(
        required.metricIds.map((id) => METRIC_DEFINITIONS.find((item) => item.id === id)!.familyId),
      ),
    ].sort(),
    analysis: {
      method: "paired-session-percentile",
      adjustment: "bonferroni",
      confidence: 0.95,
      seed,
      resamples,
      outcomes: [...OUTCOMES],
    },
    declarations: {
      nominalQueue: options.nominalQueue ?? false,
      retainedSessionGrowthBytes: options.retainedSessionGrowthBytes ?? null,
      toolTerminationDeadlineMs: options.toolTerminationDeadlineMs ?? null,
    },
    gates: GATES,
    calibration: null,
  };
  return {
    sha256: contentDigest(policy),
    policy: JSON.parse(canonicalSerialize(policy)) as BudgetPolicy,
  };
}

export interface MetricBudget {
  kind: "statistical" | "deterministic" | "coverage" | "undeclared";
  relative: number;
  absolute: number;
  absoluteP95: number | null;
}
export function metricBudget(definition: MetricDefinition, policy: BudgetPolicy): MetricBudget {
  const { id, unit, direction } = definition;
  const result: MetricBudget = { kind: "statistical", relative: 0, absolute: 0, absoluteP95: null };
  if (SAFETY_METRICS.includes(id)) return { ...result, kind: "deterministic" };
  if (id === "m11.initial-js-gzip")
    return { ...result, kind: "deterministic", absolute: GATES.initialGzipGrowthBytes };
  if (id.startsWith("m11."))
    return { ...result, kind: "deterministic", relative: GATES.totalArtifactGrowth };
  if (id === "m10.idle-footprint")
    return {
      ...result,
      relative: GATES.idleMemory.relative,
      absolute: GATES.idleMemory.absoluteBytes,
    };
  if (id === "m10.peak-footprint" || id === "m10.high-water")
    return {
      ...result,
      relative: GATES.peakMemory.relative,
      absolute: GATES.peakMemory.absoluteBytes,
    };
  if (id === "m10.post-idle-retained")
    return {
      ...result,
      kind:
        policy.declarations.retainedSessionGrowthBytes === null ? "undeclared" : "deterministic",
      absoluteP95: policy.declarations.retainedSessionGrowthBytes,
    };
  if (unit === "joules" || unit === "watts") return { ...result, relative: GATES.energyGrowth };
  if (id === "m05.cache-token-hit") return { ...result, absolute: GATES.warmCacheDropPoints / 100 };
  if (id.startsWith("m04.") && direction === "lower")
    return {
      ...result,
      relative: GATES.promptTokens.relative,
      absolute: GATES.promptTokens.absolute,
    };
  if (unit === "ms" && !id.startsWith("m14.")) {
    result.relative =
      policy.mode === "commit" ? GATES.latency.warningRelative : GATES.latency.releaseRelative;
    result.absolute = GATES.latency.releaseAbsoluteMs;
    if (id === "m01.acknowledgement") result.absoluteP95 = GATES.absoluteP95Ms.acknowledgement;
    if (id === "m01.safe-to-paint") result.absoluteP95 = GATES.absoluteP95Ms.safeToPaint;
    if (id === "m08.eligible-to-lease" && policy.declarations.nominalQueue)
      result.absoluteP95 = GATES.absoluteP95Ms.nominalQueue;
    if (id === "m13.cancellation-acknowledgement")
      result.absoluteP95 = GATES.absoluteP95Ms.stopAcknowledgement;
    if (id === "m13.terminal-stop") {
      result.absoluteP95 = policy.declarations.toolTerminationDeadlineMs;
      if (result.absoluteP95 === null) result.kind = "undeclared";
    }
    return result;
  }
  if (direction === "diagnostic") return { ...result, kind: "coverage" };
  if (unit === "ratio") return result;
  return { ...result, kind: "undeclared" };
}

export interface VerdictReason {
  code: string;
  scope: string;
  detail: string;
}
export interface MetricComparison {
  metricId: string;
  baseline: "parent" | "fixed-release";
  outcome: EvidenceOutcome | "all";
  statistic: Statistic | "exact" | "coverage";
  verdict: StatisticalVerdict;
  margin: number | null;
  estimate: PairedEstimate | null;
  absoluteVerdict: StatisticalVerdict | null;
}
export interface PerformanceVerdict {
  status: "pass" | "regression" | "incomplete";
  exitCode: 0 | 1 | 2;
  policyHash: string | null;
  mode: "commit" | "release" | null;
  releaseEligible: boolean;
  calibration: "proposed" | "frozen";
  development: "advisory";
  reasons: VerdictReason[];
  comparisons: MetricComparison[];
  evidence: {
    parent: PerformanceEvidenceEnvelope;
    candidate: PerformanceEvidenceEnvelope;
    fixedRelease: PerformanceEvidenceEnvelope;
  } | null;
}
function reason(code: string, scope: string, detail = code): VerdictReason {
  return { code, scope, detail };
}
function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : "invalid-evidence";
}
export type ReportRule =
  | "effect-count"
  | "task-pass"
  | "crash-safety"
  | "measured-usage"
  | "baseline-budget";
export interface ReportJudgeOptions {
  /** An explicit effect list is judged in full; otherwise the built-in safety counts. */
  effectMetricIds?: readonly string[];
  /** Also require the report's environment and scenario to be the policy's. */
  policy?: BudgetPolicy;
}

/**
 * The rule that decides each selected item on one report. Other metric budgets compare against a
 * baseline, and experiments only need completion, so an experiment has no rule.
 */
export function reportRules(
  required: RequiredEvidenceSelection,
  effectMetricIds: readonly string[] = SAFETY_METRICS,
): { id: string; rule: ReportRule | null }[] {
  const rule = (id: string, value: ReportRule | null) => ({ id, rule: value });
  return [
    ...required.metricIds.map((id) =>
      rule(id, effectMetricIds.includes(id) ? "effect-count" : "baseline-budget"),
    ),
    ...required.taskIds.map((id) => rule(id, "task-pass")),
    ...required.crashBoundaryIds.map((id) => rule(id, "crash-safety")),
    ...required.experimentIds.map((id) => rule(id, null)),
    ...(required.usage ? [rule("usage", "measured-usage")] : []),
  ];
}

/**
 * The verdict the comparison gives one report without a baseline: zero effect counts, passed
 * critical checks, safe expected recovery, a pass on every trial of each required task, and
 * complete measured evidence. Budget comparisons against a baseline are not part of it.
 */
export function judgeReport(
  report: PerformanceEvidenceReport,
  required: RequiredEvidenceSelection,
  options: ReportJudgeOptions = {},
): VerdictReason[] {
  const effects = options.effectMetricIds ?? SAFETY_METRICS;
  const reasons: VerdictReason[] = [];
  for (const id of effects) {
    const metric = report.metrics.find((item) => item.id === id);
    if (
      metric
        ? metric.observations.some((item) => item.value !== null && item.value > 0)
        : options.effectMetricIds !== undefined
    )
      reasons.push(reason("safety-failure", id));
  }
  for (const task of report.tasks)
    if (task.trials.some((trial) => !trial.criticalPassed))
      reasons.push(reason("safety-failure", task.id));
  for (const crash of report.crashes)
    if (
      crash.safetyPassed === false ||
      (crash.status === "complete" &&
        (crash.recovery !== CRASH_BOUNDARIES.find((item) => item.id === crash.id)!.expected ||
          (required.crashBoundaryIds.includes(crash.id) && crash.safetyPassed !== true)))
    )
      reasons.push(reason("safety-failure", crash.id));
  for (const id of required.taskIds)
    if (report.tasks.find((task) => task.id === id)?.trials.some((trial) => !trial.passed))
      reasons.push(reason("required-task-failed", id));
  try {
    validateReport(report, required, options.policy);
  } catch (error) {
    reasons.push(reason("incomplete-evidence", "candidate", errorDetail(error)));
  }
  return reasons;
}
function minimumPairs(policy: BudgetPolicy) {
  if (policy.mode === "commit") return SCOREBOARD_MANIFEST.samplePlan.commitPairs;
  if (policy.scenario.tier === "T2")
    return SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum;
  return SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs;
}
function validateReport(
  report: PerformanceEvidenceReport,
  required: RequiredEvidenceSelection,
  policy?: BudgetPolicy,
) {
  assertRequiredEvidence(report, required);
  if (policy)
    requireCondition(
      report.environmentHash === policy.environmentHash &&
        canonicalSerialize(report.scenario) === canonicalSerialize(policy.scenario),
      "policy-environment-or-scenario-mismatch",
    );
  requireCondition(
    report.artifacts.some(
      (artifact) => artifact.kind === "build" && artifact.sha256 === report.build.artifactHash,
    ),
    "missing-build-artifact-provenance",
  );
  requireCondition(
    report.artifacts.some((artifact) => artifact.kind === "raw"),
    "missing-raw-artifact-provenance",
  );
  for (const id of required.metricIds) {
    const metric = report.metrics.find((item) => item.id === id)!;
    if (metric.unit === "ms" || metric.unit === "joules" || metric.unit === "watts")
      requireCondition(
        metric.observations.every((item) => item.provenance?.kind === "measured"),
        "performance-requires-measured-durations-or-energy",
      );
    if (id.startsWith("m10."))
      requireCondition(
        report.environment.memoryAccounting !== "not-measured" &&
          report.environment.sampleIntervalMs !== null,
        "memory-accounting-or-sampling-unknown",
      );
    if (id === "m10.post-idle-retained")
      requireCondition(
        report.experiments
          .find((item) => item.id === "O12")
          ?.variants.some((item) => item.id === "soak-2h" && item.status === "complete"),
        "retained-memory-requires-soak-evidence",
      );
    if (id === "m05.cache-token-hit" && report.scenario.tier === "T3")
      requireCondition(
        metric.observations.every((item) => item.provenance?.kind === "provider-live"),
        "live-cache-requires-provider-telemetry",
      );
  }
  if (required.usage)
    requireCondition(
      report.usage.every((request) =>
        Object.values(request.categories).every(
          (value) => value.provenance?.kind !== "estimated" && value.provenance?.kind !== "virtual",
        ),
      ),
      "usage-estimates-cannot-satisfy-measured-coverage",
    );
}
function analyzePair(
  before: PerformanceEvidenceReport,
  after: PerformanceEvidenceReport,
  policy: BudgetPolicy,
  baseline: "parent" | "fixed-release",
  reasons: VerdictReason[],
): MetricComparison[] {
  const comparisons: MetricComparison[] = [];
  for (const id of policy.required.metricIds) {
    const definition = METRIC_DEFINITIONS.find((item) => item.id === id)!;
    const budget = metricBudget(definition, policy);
    const a = before.metrics.find((metric) => metric.id === id)!;
    const b = after.metrics.find((metric) => metric.id === id)!;
    const scope = `${baseline}:${id}`;
    if (budget.kind === "undeclared") {
      reasons.push(reason("undeclared-budget", scope));
      continue;
    }
    if (budget.kind === "coverage") {
      comparisons.push({
        metricId: id,
        baseline,
        outcome: "all",
        statistic: "coverage",
        verdict: "within-budget",
        margin: null,
        estimate: null,
        absoluteVerdict: null,
      });
      continue;
    }
    if (budget.kind === "deterministic") {
      const x = Math.max(...a.observations.map((item) => item.value!));
      const y = Math.max(...b.observations.map((item) => item.value!));
      const margin = Math.max(x * budget.relative, budget.absolute);
      const violation = SAFETY_METRICS.includes(id)
        ? y > 0
        : budget.absoluteP95 !== null
          ? exceeds(y, budget.absoluteP95)
          : exceeds(y - x, margin);
      comparisons.push({
        metricId: id,
        baseline,
        outcome: "all",
        statistic: "exact",
        verdict: violation ? "regressed" : y < x ? "improved" : "within-budget",
        margin,
        estimate: null,
        absoluteVerdict: null,
      });
      continue;
    }
    const byPair = new Map(a.observations.map((item) => [item.pairId, item]));
    if (b.observations.some((item) => byPair.get(item.pairId)?.outcome !== item.outcome)) {
      reasons.push(reason("outcome-pairing-changed", scope));
      continue;
    }
    // Allocate alpha across families, members, both baselines, two statistics and six strata.
    // Absolute p95 bounds get a separate allocation, including when no such target is selected.
    const members = policy.required.metricIds.filter(
      (metricId) =>
        METRIC_DEFINITIONS.find((item) => item.id === metricId)!.familyId === definition.familyId,
    ).length;
    const alpha =
      (1 - policy.analysis.confidence) / (policy.familyIds.length * members * 2 * 3 * 6);
    for (const outcome of ["all", ...OUTCOMES] as const) {
      const left = a.observations.filter((item) => outcome === "all" || item.outcome === outcome);
      const right = b.observations.filter((item) => outcome === "all" || item.outcome === outcome);
      if (!left.length && !right.length) continue;
      try {
        requireCondition(
          pairedSessions(left, right).length >= minimumPairs(policy),
          "insufficient-independent-pairs",
        );
        for (const statistic of ["p50", "p95"] as const) {
          const estimate = pairedBootstrap(left, right, {
            ...policy.analysis,
            alpha,
            statistic,
            direction: definition.direction as "lower" | "higher",
          });
          const margin = Math.max(budget.absolute, budget.relative * estimate.before.value);
          let verdict = classifyInterval(estimate.degradation.interval, margin);
          if (policy.mode === "commit")
            verdict = exceeds(estimate.degradation.value, margin) ? "regressed" : verdict;
          const absoluteVerdict =
            statistic === "p95" && budget.absoluteP95 !== null
              ? classifyInterval(estimate.after.interval, budget.absoluteP95)
              : null;
          comparisons.push({
            metricId: id,
            baseline,
            outcome,
            statistic,
            estimate,
            margin,
            verdict,
            absoluteVerdict,
          });
        }
      } catch (error) {
        reasons.push(reason("incomplete-analysis", `${scope}:${outcome}`, errorDetail(error)));
      }
    }
  }
  return comparisons;
}

function validateCalibration(policy: BudgetPolicy) {
  const calibration = policy.calibration;
  requireCondition(calibration && calibration.reports.length >= 2, "calibration-required");
  requireCondition(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(calibration.frozenAt) &&
      new Date(calibration.frozenAt).toISOString() === calibration.frozenAt,
    "invalid-freeze-time",
  );
  const envelopes = calibration.reports.map(parsePerformanceEvidenceEnvelope);
  requireCondition(
    new Set(envelopes.map((item) => item.sha256)).size === envelopes.length,
    "duplicate-calibration-report",
  );
  const first = envelopes[0]!.report;
  for (const { report } of envelopes) {
    // One judge run validates the report and gives its verdict; incomplete evidence keeps its detail.
    const failures = judgeReport(report, policy.required, { policy });
    const incomplete = failures.find((item) => item.code === "incomplete-evidence");
    requireCondition(!incomplete, incomplete?.detail ?? "incomplete-evidence");
    requireCondition(report.createdAt < calibration.frozenAt, "calibration-after-freeze");
    requireCondition(
      report.build.commit === first.build.commit &&
        report.build.artifactHash === first.build.artifactHash,
      "calibration-must-use-same-build",
    );
    requireCondition(!failures.length, "calibration-verdict-failed");
  }
  for (const { report } of envelopes.slice(1)) {
    const reasons: VerdictReason[] = [];
    assertCalibrationPerformanceEvidence(first, report);
    const comparisons = analyzePair(first, report, policy, "parent", reasons);
    requireCondition(
      !reasons.length &&
        comparisons.every((item) =>
          [item.verdict, item.absoluteVerdict].every(
            (value) => value === null || value === "improved" || value === "within-budget",
          ),
        ),
      "calibration-outside-budget-or-incomplete",
    );
  }
}

export function freezeBudgetPolicy(
  proposed: BudgetPolicyEnvelope,
  reports: PerformanceEvidenceEnvelope[],
  frozenAt: string,
): BudgetPolicyEnvelope {
  const parsed = parseBudgetPolicy(proposed);
  requireCondition(parsed.policy.calibration === null, "policy-already-frozen");
  parsed.policy.calibration = { frozenAt, reports };
  validateCalibration(parsed.policy);
  return parseBudgetPolicy({ sha256: contentDigest(parsed.policy), policy: parsed.policy });
}

export function parseBudgetPolicy(value: unknown): BudgetPolicyEnvelope {
  const copy = JSON.parse(canonicalSerialize(value)) as BudgetPolicyEnvelope;
  requireCondition(
    copy &&
      Object.keys(copy).sort().join(",") === "policy,sha256" &&
      copy.sha256 === contentDigest(copy.policy),
    "policy-checksum-mismatch",
  );
  const policy = copy.policy;
  const expected = createBudgetPolicy(policy.required, {
    mode: policy.mode,
    environmentHash: policy.environmentHash,
    scenario: policy.scenario,
    seed: policy.analysis.seed,
    resamples: policy.analysis.resamples,
    ...policy.declarations,
  });
  requireCondition(
    canonicalSerialize({ ...policy, calibration: null }) === canonicalSerialize(expected.policy),
    "unsupported-or-modified-policy",
  );
  if (policy.calibration !== null) validateCalibration(policy);
  return copy;
}

/** W0-9 pins the policy hash before collecting candidates and verifies artifact bytes on ingestion. */
export function comparePerformanceEvidence(input: {
  policy: unknown;
  parent: unknown;
  candidate: unknown;
  fixedRelease: unknown;
}): PerformanceVerdict {
  const result: PerformanceVerdict = {
    status: "incomplete",
    exitCode: 2,
    policyHash: null,
    mode: null,
    releaseEligible: false,
    calibration: "proposed",
    development: "advisory",
    reasons: [],
    comparisons: [],
    evidence: null,
  };
  let policy: BudgetPolicy;
  try {
    const parsed = parseBudgetPolicy(input.policy);
    policy = parsed.policy;
    result.mode = policy.mode;
    result.policyHash = parsed.sha256;
    result.calibration = policy.calibration ? "frozen" : "proposed";
  } catch (error) {
    result.reasons.push(reason("invalid-policy", "policy", errorDetail(error)));
    return result;
  }
  try {
    result.evidence = {
      parent: parsePerformanceEvidenceEnvelope(input.parent),
      candidate: parsePerformanceEvidenceEnvelope(input.candidate),
      fixedRelease: parsePerformanceEvidenceEnvelope(input.fixedRelease),
    };
  } catch (error) {
    result.reasons.push(reason("invalid-evidence", "reports", errorDetail(error)));
    return result;
  }
  const { parent, candidate, fixedRelease } = result.evidence;
  result.reasons.push(...judgeReport(candidate.report, policy.required, { policy }));
  for (const [scope, { report }] of Object.entries({ parent, fixedRelease })) {
    try {
      validateReport(report, policy.required, policy);
    } catch (error) {
      result.reasons.push(reason("incomplete-evidence", scope, errorDetail(error)));
    }
  }
  if (
    parent.report.build.commit !== candidate.report.build.parentCommit ||
    fixedRelease.report.build.commit !== candidate.report.build.fixedReleaseCommit
  )
    result.reasons.push(reason("baseline-commit-mismatch", "reports"));
  if (policy.mode === "release" && !policy.calibration)
    result.reasons.push(reason("calibration-required", "policy"));
  if (policy.calibration && candidate.report.createdAt <= policy.calibration.frozenAt)
    result.reasons.push(reason("candidate-before-policy-freeze", "candidate"));
  if (
    !result.reasons.some(
      (item) => item.code === "incomplete-evidence" || item.code === "baseline-commit-mismatch",
    )
  ) {
    for (const [scope, envelope] of [
      ["parent", parent],
      ["fixed-release", fixedRelease],
    ] as const) {
      try {
        assertComparablePerformanceEvidence(envelope.report, candidate.report);
        result.comparisons.push(
          ...analyzePair(envelope.report, candidate.report, policy, scope, result.reasons),
        );
      } catch (error) {
        result.reasons.push(reason("incomparable-evidence", scope, errorDetail(error)));
      }
    }
  }
  for (const item of result.comparisons) {
    const scope = `${item.baseline}:${item.metricId}:${item.outcome}:${item.statistic}`;
    if (item.verdict === "regressed" || item.absoluteVerdict === "regressed")
      result.reasons.push(reason("budget-regression", scope));
    if (item.verdict === "inconclusive" || item.absoluteVerdict === "inconclusive")
      result.reasons.push(reason("inconclusive-interval", scope));
  }
  const regressed = result.reasons.some((item) =>
    ["safety-failure", "required-task-failed", "budget-regression"].includes(item.code),
  );
  result.status = regressed ? "regression" : result.reasons.length ? "incomplete" : "pass";
  result.exitCode = PERFORMANCE_EXIT_CODES[result.status];
  result.releaseEligible =
    result.status === "pass" && policy.mode === "release" && result.calibration === "frozen";
  return result;
}
