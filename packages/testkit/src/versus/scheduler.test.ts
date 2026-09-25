import { describe, expect, it } from "vitest";
import { summarizeResources } from "./resources.js";
import type { PairedResult } from "./scheduler.js";
import {
  analyzePairs,
  efficiencyInterval,
  pairedDistribution,
  planPairs,
  validatePairs,
  zeroFailureUpperBound,
} from "./scheduler.js";
import { selfTestBudget } from "./self-test.js";

describe("paired analysis and resource denominators", () => {
  const plan = planPairs(selfTestBudget().cohort);
  const results: PairedResult[] = plan.flatMap((pair) =>
    pair.order.map((product) => ({
      pairId: pair.id,
      taskId: pair.taskId,
      cluster: pair.cluster,
      product,
      accepted: false,
      criticalPassed: true,
      reason: "budget-exhausted",
      tier: "T0",
      elapsedMs: null,
      logicalInput: null,
      cost: null,
    })),
  );
  it("freezes serial A/B order and pairs while balancing declared history", () => {
    expect(planPairs(selfTestBudget().cohort)).toEqual(plan);
    expect(new Set(plan.map((pair) => pair.order.join("-"))).size).toBe(2);
    expect(plan.every((pair) => pair.order.length === 2)).toBe(true);
    const balanced = planPairs({
      ...selfTestBudget().cohort,
      tasks: ["task-01"],
      repetitions: 20,
      history: "balanced",
    });
    expect(balanced.filter((pair) => pair.history === "long")).toHaveLength(10);
  });
  it("keeps every failure in planned denominators and never prices zero accepted tasks as zero", () => {
    const report = analyzePairs(plan, results);
    expect(report.descriptive[0]).toMatchObject({
      planned: 24,
      attempted: 24,
      acceptanceRate: 0,
      allAttemptCostPerAccepted: null,
    });
    expect(report.qualityVerdict).toBe("inconclusive");
    expect(report.efficiencyEligible).toBe(false);
    expect(report.guards.every((guard) => guard.interval === null)).toBe(true);
    expect(report.globalSuperiority).toBeNull();
  });
  it("rejects duplicates, unpaired IDs, and cluster reassignment", () => {
    expect(validatePairs(plan, results)).toBe(true);
    expect(validatePairs(plan, results.slice(1))).toBe(false);
    expect(() => validatePairs(plan, [...results, results[0]!])).toThrow("Duplicate");
    expect(() => validatePairs(plan, [{ ...results[0]!, cluster: "fake-independent" }])).toThrow();
  });
  it("withholds wide department guards despite many pooled successes", () => {
    const live = results.map((result) => ({ ...result, accepted: true, tier: "T3" as const }));
    const report = analyzePairs(plan, live);
    expect(report.guards[0]?.interval?.independentClusters).toBe(24);
    expect(report.guards[1]?.interval).toBeNull();
    expect(report.efficiencyEligible).toBe(false);
    expect(report.guards[0]?.interval?.alpha).toBeLessThan(0.05 / 4);
    expect(zeroFailureUpperBound(60)).toBeCloseTo(0.0487, 3);
  });
  it("uses W0-8 bootstrap and reports no ratio for zero baselines", () => {
    const values = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      sessionId: `s-${i}`,
      pairId: `p-${i}`,
      traceId: `t-${i}`,
      outcome: "success" as const,
      value: 0,
      missingReason: null,
      provenance: null,
    }));
    expect(pairedDistribution(values, values, "p50").ratio).toBeNull();
  });
  it("clusters correlated variants and retains failed-attempt spending in ratio intervals", () => {
    const observed = results.map((result) => ({
      ...result,
      accepted: true,
      tier: "T3" as const,
      cost: result.product === "ardur" ? 1 : 2,
    }));
    expect(efficiencyInterval(observed, "cost")).toMatchObject({
      value: 0.5,
      lower: 0.5,
      upper: 0.5,
      independentClusters: 24,
    });
    expect(
      efficiencyInterval(
        observed.map((result) => ({ ...result, cluster: "one-trajectory" })),
        "cost",
      ),
    ).toBeNull();
    expect(
      efficiencyInterval(
        observed.map((result) => ({ ...result, cost: 0 })),
        "cost",
      ),
    ).toBeNull();
    const failed = observed.map((result, index) => ({
      ...result,
      accepted: index < 6 ? false : result.accepted,
      cost: index < 6 && result.product === "ardur" ? 100 : result.cost,
    }));
    expect(efficiencyInterval(failed, "cost")!.value).toBeGreaterThan(1);
    expect(
      efficiencyInterval(
        observed.map((result, index) => (index === 0 ? { ...result, cost: null } : result)),
        "cost",
      ),
    ).toBeNull();
  });
  it("prevents duplicate process rows and guest/VM memory double counting", () => {
    const vm = {
      pid: 10,
      parentPid: 1,
      rssBytes: 100,
      cpuMs: 10,
      domain: "host" as const,
      vmId: "vm-a",
      role: "vm" as const,
    };
    const guest = {
      ...vm,
      pid: 11,
      domain: "guest" as const,
      role: "product" as const,
      rssBytes: 90,
    };
    const model = { ...vm, pid: 12, vmId: null, role: "model" as const, rssBytes: 500 };
    expect(summarizeResources([vm, guest, model])).toMatchObject({
      productRssBytes: 100,
      sharedModelRssBytes: 500,
      joules: null,
      physicalBytes: null,
    });
    expect(() => summarizeResources([vm, vm])).toThrow("Duplicate");
  });
});
