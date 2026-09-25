import { RequestUsageObservationSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { normalizeUsageCounts, RequestUsageCollector } from "./usage-collection.js";

describe("normalized usage categories", () => {
  it("adds independent input components and keeps reasoning inside output", () => {
    expect(
      normalizeUsageCounts(
        { input: 12, cacheRead: 80, cacheWrite: 20, output: 8, reasoning: 3 },
        "additive-cache-categories",
      ).categories,
    ).toEqual({
      logicalInput: 112,
      uncachedInput: 12,
      cacheReadInput: 80,
      cacheWriteInput: 20,
      output: 8,
      reasoning: 3,
    });
    expect(
      normalizeUsageCounts(
        { input: 112, cacheRead: 80, cacheWrite: 20, output: 8, reasoning: 3 },
        "total-with-cache-subsets",
      ).categories,
    ).toEqual({
      logicalInput: 112,
      uncachedInput: 12,
      cacheReadInput: 80,
      cacheWriteInput: 20,
      output: 8,
      reasoning: 3,
    });
  });
  it("keeps omitted detail unknown and preserves reported zero", () => {
    const mapped = normalizeUsageCounts({ input: 0, output: 0 }, "total-with-cache-subsets");
    expect(mapped.categories).toEqual({
      logicalInput: 0,
      uncachedInput: null,
      cacheReadInput: null,
      cacheWriteInput: null,
      output: 0,
      reasoning: null,
    });
    expect(
      normalizeUsageCounts({ input: 12, output: 8 }, "additive-cache-categories").categories
        .logicalInput,
    ).toBeNull();
  });
  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648, "10"])(
    "rejects invalid supplied counts: %s",
    (input) => {
      const mapped = normalizeUsageCounts({ input }, "total-with-cache-subsets");
      expect(mapped.invalid).toBe(true);
      expect(Object.values(mapped.categories).every((value) => value === null)).toBe(true);
      expect(mapped.raw).toEqual({});
    },
  );
  it("rejects overlapping input, excess reasoning and aggregate overflow", () => {
    for (const raw of [
      { input: 5, cacheRead: 6 },
      { output: 5, reasoning: 6 },
      { input: 2_147_483_647, output: 1 },
    ]) {
      expect(normalizeUsageCounts(raw, "total-with-cache-subsets").invalid).toBe(true);
    }
  });
});

it("emits stable cumulative identities and closes failed requests without inventing usage or cost", () => {
  const collector = new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    mappingVersion: "fixture-v1",
    inputSemantics: "total-with-cache-subsets",
  });
  const start = collector.start();
  const end = collector.finish("cancelled");
  expect(start.request?.collection).toMatchObject({
    outcome: "started",
    availability: "unavailable",
    raw: {},
  });
  expect(end.request).toMatchObject({
    requestId: start.request?.requestId,
    attemptId: start.request?.attemptId,
    counter: { sequence: 1 },
    cost: null,
    pricingProvenance: null,
    collection: { outcome: "cancelled", availability: "unavailable" },
  });
  expect(Object.values(end.request!.categories).every((value) => value === null)).toBe(true);
  expect(RequestUsageObservationSchema.safeParse(end.request).success).toBe(true);
  expect(
    RequestUsageObservationSchema.safeParse({
      ...end.request,
      collection: { ...end.request!.collection, raw: { prompt: "private" } },
    }).success,
  ).toBe(false);
});
