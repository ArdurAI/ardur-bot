import type { RequestUsageObservation, UsageCategories } from "@ardurbot/adapter-kit";
import { expect, it } from "vitest";
import type { RequestUsageEvidence } from "./performance-report.js";
import { USAGE_CATEGORIES } from "./performance-report.js";

// The scoreboard is downstream of adapter-kit. Do not add a runtime dependency in the other direction.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const compatible: [
  Equal<keyof UsageCategories, keyof RequestUsageEvidence["categories"]>,
  Equal<RequestUsageObservation["purpose"], RequestUsageEvidence["purpose"]>,
  Equal<RequestUsageObservation["inputSemantics"], RequestUsageEvidence["inputSemantics"]>,
  Equal<RequestUsageObservation["reasoningSemantics"], RequestUsageEvidence["reasoningSemantics"]>,
] = [true, true, true, true];

it("keeps the provider-neutral ledger compatible with all schema-3 category and attribution types", () => {
  expect(compatible.every(Boolean)).toBe(true);
  const categories: UsageCategories = {
    logicalInput: 100,
    uncachedInput: 60,
    cacheReadInput: 30,
    cacheWriteInput: 10,
    output: 0,
    reasoning: null,
  };
  expect(Object.keys(categories)).toEqual(USAGE_CATEGORIES);
  // Collectors must keep an absent provider category distinct from measured zero.
  expect(USAGE_CATEGORIES.filter((key) => categories[key] === null)).toEqual(["reasoning"]);
  expect(USAGE_CATEGORIES.filter((key) => categories[key] === 0)).toEqual(["output"]);
});
