import type { RequestUsageObservation } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { accumulateRequestUsage, parseRequestUsage, usageTokenTotals } from "./request-usage.js";

function observation(patch: Partial<RequestUsageObservation> = {}): RequestUsageObservation {
  return {
    requestId: "request",
    attemptId: "attempt",
    parentRequestId: null,
    purpose: "main",
    counter: { mode: "delta", epochId: "epoch", sequence: 0 },
    inputSemantics: "total-with-cache-subsets",
    reasoningSemantics: "subset-of-output",
    categories: {
      logicalInput: 100,
      uncachedInput: 60,
      cacheReadInput: 30,
      cacheWriteInput: 10,
      output: 50,
      reasoning: 20,
    },
    cost: null,
    pricingProvenance: null,
    ...patch,
  };
}

describe("request usage normalization", () => {
  it("does not add cache or subset reasoning tokens to logical totals", () => {
    const totals = accumulateRequestUsage(null, observation());
    expect(usageTokenTotals(totals.categories, "subset-of-output")).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(usageTokenTotals(totals.categories, "separate")).toEqual({
      inputTokens: 100,
      outputTokens: 70,
    });
  });
  it.each(["total-with-cache-subsets", "additive-cache-categories"] as const)(
    "retains all categories under %s",
    (inputSemantics) => {
      const request = parseRequestUsage(observation({ inputSemantics }));
      expect(accumulateRequestUsage(null, request).categories).toEqual(request.categories);
    },
  );
  it("keeps measured zero distinct from unavailable usage and unknown cost", () => {
    const unknown = observation({
      inputSemantics: "unknown",
      reasoningSemantics: "unknown",
      categories: {
        logicalInput: null,
        uncachedInput: null,
        cacheReadInput: null,
        cacheWriteInput: null,
        output: 0,
        reasoning: null,
      },
    });
    const totals = accumulateRequestUsage(null, parseRequestUsage(unknown));
    expect(totals.categories.logicalInput).toBeNull();
    expect(totals.categories.output).toBe(0);
    expect(totals.categoryCoverage.logicalInput).toBe("unknown");
    expect(totals.categoryCoverage.output).toBe("complete");
    expect(totals.cost).toBeNull();
  });
  it("keeps missing delta coverage partial even when later deltas report usage", () => {
    const first = observation({
      categories: { ...observation().categories, cacheReadInput: null },
    });
    const previous = accumulateRequestUsage(null, first);
    const next = accumulateRequestUsage(previous, observation());
    expect(next.categories.cacheReadInput).toBe(30);
    expect(next.categories.logicalInput).toBe(200);
    expect(next.categoryCoverage.cacheReadInput).toBe("partial");
  });
  it("uses a cumulative correction to fill missing categories without charging input again", () => {
    const first = observation({
      counter: { mode: "cumulative", epochId: "epoch", sequence: 0 },
      categories: { ...observation().categories, cacheReadInput: null },
    });
    const previous = accumulateRequestUsage(null, first);
    const next = accumulateRequestUsage(previous, {
      ...first,
      counter: { ...first.counter, sequence: 1 },
      categories: observation().categories,
    });
    expect(next.categories).toEqual(observation().categories);
    expect(Object.values(next.categoryCoverage)).toEqual(Array(6).fill("complete"));
    expect(usageTokenTotals(next.categories, first.reasoningSemantics)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
  it("retains cumulative lower bounds through missing observations and charges only new spend", () => {
    const first = observation({ counter: { mode: "cumulative", epochId: "epoch", sequence: 0 } });
    const previous = accumulateRequestUsage(null, first);
    const missing = { ...first, categories: { ...first.categories, logicalInput: null } };
    const partial = accumulateRequestUsage(previous, missing);
    expect(partial.categories.logicalInput).toBe(100);
    expect(partial.categoryCoverage.logicalInput).toBe("partial");
    expect(accumulateRequestUsage(partial, first).categoryCoverage.logicalInput).toBe("complete");
  });
  it("rejects reset counters in the same epoch", () => {
    const first = observation({ counter: { mode: "cumulative", epochId: "epoch", sequence: 0 } });
    const previous = accumulateRequestUsage(null, first);
    expect(() =>
      accumulateRequestUsage(previous, {
        ...first,
        categories: { ...first.categories, output: 25 },
      }),
    ).toThrow("decreased");
  });
  it("requires applicable dated prices, including for a measured zero cost", () => {
    expect(() => parseRequestUsage(observation({ cost: 0 }))).toThrow("dated pricing");
    const priced = observation({
      cost: 0,
      pricingProvenance: { source: "fixture-rate-v1", datedAt: "2026-09-24", kind: "rate-card" },
    });
    expect(accumulateRequestUsage(null, parseRequestUsage(priced)).cost).toBe(0);
    const unknown = accumulateRequestUsage(null, observation());
    expect(accumulateRequestUsage(unknown, priced).cost).toBeNull();
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid counts (%s)",
    (logicalInput) => {
      expect(() =>
        parseRequestUsage(
          observation({ categories: { ...observation().categories, logicalInput } }),
        ),
      ).toThrow();
    },
  );
  it.each([
    { categories: { ...observation().categories, logicalInput: 99 } },
    { categories: { ...observation().categories, logicalInput: 101 } },
    { categories: { ...observation().categories, reasoning: 51 } },
    { inputSemantics: "unknown" as const },
    {
      inputSemantics: "unknown" as const,
      categories: { ...observation().categories, uncachedInput: null, cacheWriteInput: null },
    },
    { reasoningSemantics: "unknown" as const },
    { parentRequestId: "request" },
    { requestId: "" },
    { counter: { mode: "delta" as const, epochId: "epoch", sequence: -1 } },
  ])("rejects incoherent or ambiguous metadata (%j)", (patch) => {
    expect(() => parseRequestUsage(observation(patch))).toThrow();
  });
  it("rejects unrecognized payloads and integer overflow rather than retaining provider bodies", () => {
    expect(() =>
      parseRequestUsage({ ...observation(), response: { text: "untrusted" } }),
    ).toThrow();
    const previous = accumulateRequestUsage(null, observation());
    previous.categories.logicalInput = 2_147_483_640;
    expect(() => accumulateRequestUsage(previous, observation())).toThrow();
  });
});
