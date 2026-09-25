import type { MetricObservation } from "../performance-report.js";
import { contentDigest } from "../scoreboard/manifest.js";
import { pairedBootstrap } from "../scoreboard/statistics.js";
import { getTask } from "../scoreboard/tasks/catalog.js";
import type { Budget } from "./budget.js";
import { requireValue } from "./budget.js";
import type { Product } from "./manifest.js";
import { ANALYSIS_SEED, PRODUCTS, VERSUS_PROTOCOL } from "./manifest.js";

export function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export interface PairPlan {
  id: string;
  taskId: string;
  department: string;
  repetition: number;
  history: "short" | "long";
  cacheState: string;
  order: Product[];
  cluster: string;
}
export function planPairs(cohort: Budget["cohort"]): PairPlan[] {
  const random = randomGenerator(ANALYSIS_SEED);
  const plans: PairPlan[] = [];
  for (const taskId of cohort.tasks)
    for (let repetition = 0; repetition < cohort.repetitions; repetition++) {
      const task = getTask(taskId);
      const id = `pair-${contentDigest({ taskId, repetition, seed: ANALYSIS_SEED }).slice(0, 20)}`;
      plans.push({
        id,
        taskId,
        department: task.department,
        repetition,
        history: cohort.history === "balanced" && repetition % 2 ? "long" : "short",
        cacheState: cohort.cacheState,
        order: random() < 0.5 ? ["ardur", "hermes"] : ["hermes", "ardur"],
        cluster: id,
      });
    }
  for (let index = plans.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [plans[index], plans[other]] = [plans[other]!, plans[index]!];
  }
  return plans;
}
export interface PairedResult {
  pairId: string;
  product: Product;
  taskId: string;
  cluster: string;
  accepted: boolean;
  criticalPassed: boolean;
  reason: string;
  tier: "T0" | "T3";
  elapsedMs: number | null;
  logicalInput: number | null;
  cost: number | null;
}
export function validatePairs(plan: PairPlan[], results: PairedResult[]) {
  const ids = new Set<string>();
  requireValue(new Set(plan.map((pair) => pair.id)).size === plan.length, "Duplicate planned pair");
  for (const result of results) {
    const pair = plan.find((item) => item.id === result.pairId);
    requireValue(
      pair &&
        PRODUCTS.includes(result.product) &&
        result.taskId === pair.taskId &&
        result.cluster === pair.cluster,
      "Unpaired trial or changed cluster",
    );
    const id = `${result.pairId}:${result.product}`;
    requireValue(!ids.has(id), "Duplicate product in pair");
    ids.add(id);
    requireValue(
      !result.accepted || result.criticalPassed,
      "Acceptance contradicts critical outcome",
    );
    for (const key of ["elapsedMs", "logicalInput", "cost"] as const)
      requireValue(
        result[key] === null || (Number.isFinite(result[key]) && result[key]! >= 0),
        "Invalid paired measurement",
      );
  }
  return plan.every((pair) => PRODUCTS.every((product) => ids.has(`${pair.id}:${product}`)));
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function quantile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
const alpha = 0.05 / (4 * 7);

/** Every attempted run contributes cost; accepting nothing has no finite cost-per-success. */
export function efficiencyInterval(
  results: PairedResult[],
  metric: "elapsedMs" | "logicalInput" | "cost",
) {
  if (!results.length || results.some((result) => result[metric] === null)) return null;
  const groups = new Map<string, PairedResult[]>();
  for (const result of results)
    groups.set(result.cluster, [...(groups.get(result.cluster) ?? []), result]);
  if (groups.size < VERSUS_PROTOCOL.minimumIndependentPairs) return null;
  const ratio = (sample: PairedResult[]) => {
    const costs = PRODUCTS.map((product) => {
      const values = sample.filter((item) => item.product === product);
      const accepted = values.filter((item) => item.accepted).length;
      return accepted ? values.reduce((sum, item) => sum + item[metric]!, 0) / accepted : null;
    });
    return costs[0] !== null && costs[1] !== null && costs[1]! > 0 ? costs[0]! / costs[1]! : null;
  };
  const value = ratio(results);
  if (value === null) return null;
  const samples = [...groups.values()];
  const random = randomGenerator(ANALYSIS_SEED);
  const draws: number[] = [];
  for (let draw = 0; draw < 24000; draw++) {
    const value = ratio(samples.flatMap(() => samples[Math.floor(random() * samples.length)]!));
    // No selective removal of undefined bootstrap samples.
    if (value === null || !Number.isFinite(value)) return null;
    draws.push(value);
  }
  return {
    value,
    lower: quantile(draws, alpha / 2),
    upper: quantile(draws, 1 - alpha / 2),
    independentClusters: groups.size,
    alpha,
    estimand: "all-attempt-resource-per-accepted-task-ratio",
  };
}

/** Cross-product quality is a paired mean difference; W0-8's build regression margins are inapplicable. */
function qualityInterval(results: PairedResult[]) {
  const pairs = [...new Set(results.map((result) => result.pairId))];
  const groups = new Map<string, number[]>();
  for (const pair of pairs) {
    const a = results.find((item) => item.pairId === pair && item.product === "ardur")!;
    const h = results.find((item) => item.pairId === pair && item.product === "hermes")!;
    const group = groups.get(a.cluster) ?? [];
    group.push(Number(a.accepted) - Number(h.accepted));
    groups.set(a.cluster, group);
  }
  if (groups.size < VERSUS_PROTOCOL.minimumIndependentPairs) return null;
  const samples = [...groups.values()];
  const random = randomGenerator(ANALYSIS_SEED);
  const draws = Array.from({ length: 24000 }, () =>
    mean(samples.flatMap(() => samples[Math.floor(random() * samples.length)]!)),
  );
  return {
    value: mean(samples.flat()),
    lower: quantile(draws, alpha / 2),
    upper: quantile(draws, 1 - alpha / 2),
    independentClusters: groups.size,
    alpha,
  };
}
export function analyzePairs(plan: PairPlan[], results: PairedResult[]) {
  const complete = validatePairs(plan, results);
  const live = results.length > 0 && results.every((result) => result.tier === "T3");
  const descriptive = PRODUCTS.map((product) => {
    const selected = results.filter((result) => result.product === product);
    const accepted = selected.filter((result) => result.accepted).length;
    const priced = selected.length > 0 && selected.every((result) => result.cost !== null);
    return {
      product,
      planned: plan.length,
      attempted: selected.length,
      accepted,
      acceptanceRate: plan.length ? accepted / plan.length : null,
      allAttemptCostPerAccepted:
        accepted && priced
          ? selected.reduce((sum, result) => sum + result.cost!, 0) / accepted
          : null,
      outcomes: Object.fromEntries(
        [...new Set(selected.map((result) => result.reason))].map((reason) => [
          reason,
          selected.filter((result) => result.reason === reason).length,
        ]),
      ),
    };
  });
  const departments = [...new Set(plan.map((pair) => pair.department))];
  const guards = ["overall", ...departments].map((department) => {
    const selected =
      department === "overall"
        ? results
        : results.filter((result) => getTask(result.taskId).department === department);
    const interval = complete && live && selected.length ? qualityInterval(selected) : null;
    return {
      department,
      interval,
      noninferior:
        interval !== null &&
        interval.lower > -0.05 &&
        selected.every((result) => result.criticalPassed),
    };
  });
  const overall = guards[0]?.interval;
  const fullCohort =
    new Set(plan.map((pair) => pair.taskId)).size === 24 &&
    [...new Set(plan.map((pair) => pair.taskId))].every(
      (taskId) =>
        plan.filter((pair) => pair.taskId === taskId).length >=
        VERSUS_PROTOCOL.minimumIndependentPairs,
    );
  const efficiencyEligible =
    complete &&
    live &&
    fullCohort &&
    guards.length === 7 &&
    guards.every((guard) => guard.noninferior);
  return {
    kind: live ? "exploratory-paired-cohort" : "virtual-contracts-no-product-quality-inference",
    complete,
    descriptive,
    guards,
    analysisSeed: ANALYSIS_SEED,
    correction: VERSUS_PROTOCOL.correction,
    qualityVerdict:
      fullCohort &&
      guards.length === 7 &&
      overall &&
      overall.value >= 0.05 &&
      overall.lower > 0 &&
      guards.every((guard) => guard.noninferior)
        ? "quality-improved-on-declared-cohort"
        : "inconclusive",
    efficiencyEligible,
    efficiency: (["elapsedMs", "logicalInput", "cost"] as const).map((metric) => {
      const interval = efficiencyEligible ? efficiencyInterval(results, metric) : null;
      return {
        metric,
        interval,
        verdict:
          interval && interval.upper <= 0.1
            ? "10x-on-declared-cohort"
            : interval && interval.upper <= VERSUS_PROTOCOL.efficiencyRatio
              ? "efficient-on-declared-cohort"
              : "inconclusive",
        reason: interval
          ? null
          : "Complete comparable measurements, C20 samples and all department quality guards are required",
      };
    }),
    globalSuperiority: null,
  };
}

/** Reuse W0-8's paired/clustered descriptive p50/p95; zero baselines have no ratio. */
export function pairedDistribution(
  before: MetricObservation[],
  after: MetricObservation[],
  statistic: "p50" | "p95",
) {
  const estimate = pairedBootstrap(before, after, {
    seed: ANALYSIS_SEED,
    resamples: 24000,
    alpha,
    statistic,
    direction: "lower",
  });
  return {
    ...estimate,
    ratio: estimate.before.value > 0 ? estimate.after.value / estimate.before.value : null,
    exploratory: estimate.independentPairs < 20,
  };
}
export function zeroFailureUpperBound(independentClusters: number) {
  requireValue(
    Number.isSafeInteger(independentClusters) && independentClusters > 0,
    "Independent clusters required",
  );
  return 1 - 0.05 ** (1 / independentClusters);
}
