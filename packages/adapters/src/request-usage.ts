import type { RequestUsageObservation, UsageCategories } from "@ardurbot/adapter-kit";
import { hasIncompleteUsage } from "@ardurbot/adapter-kit";
import { RequestUsageObservationSchema, UsageCategoriesSchema } from "@ardurbot/contracts";
import { z } from "zod";

const token = z.number().int().min(0).max(2_147_483_647);
const categoriesSchema = UsageCategoriesSchema;

export const REQUEST_USAGE_CATEGORIES = categoriesSchema.keyof().options;
export type CategoryCoverage = Record<keyof UsageCategories, "complete" | "partial" | "unknown">;

/** Strictly whitelist metadata: provider responses, prompts and credentials do not belong here. */
export const requestUsageSchema =
  RequestUsageObservationSchema satisfies z.ZodType<RequestUsageObservation>;

export interface RequestUsageTotals {
  categories: UsageCategories;
  categoryCoverage: CategoryCoverage;
  cost: number | null;
}

export function usageTokenTotals(categories: UsageCategories, reasoningSemantics: string) {
  const inputTokens = categories.logicalInput ?? 0;
  const outputTokens =
    (categories.output ?? 0) +
    (reasoningSemantics === "separate" ? (categories.reasoning ?? 0) : 0);
  token.parse(inputTokens + outputTokens);
  return { inputTokens, outputTokens };
}

export function validateUsageCategories(
  categories: UsageCategories,
  inputSemantics: string,
  reasoningSemantics: string,
) {
  const { logicalInput, uncachedInput, cacheReadInput, cacheWriteInput, output, reasoning } =
    categories;
  const components = [uncachedInput, cacheReadInput, cacheWriteInput];
  const supplied = components.filter((value): value is number => value !== null);
  const sum = supplied.reduce((total, value) => total + value, 0);
  if (
    logicalInput !== null &&
    (sum > logicalInput || (supplied.length === 3 && sum !== logicalInput))
  )
    throw new Error("Usage input categories must partition logical input");
  if (inputSemantics === "unknown" && supplied.length > 0)
    throw new Error("Reported input components require declared semantics");
  if (
    reasoningSemantics === "subset-of-output" &&
    output !== null &&
    reasoning !== null &&
    reasoning > output
  )
    throw new Error("Usage reasoning subset exceeds output");
  if (reasoningSemantics === "unknown" && reasoning !== null)
    throw new Error("Reported reasoning requires declared semantics");
  usageTokenTotals(categories, reasoningSemantics);
}

export function parseRequestUsage(value: unknown): RequestUsageObservation {
  const request = requestUsageSchema.parse(value);
  if (request.requestId === request.parentRequestId)
    throw new Error("Usage request cannot parent itself");
  if ((request.cost === null) !== (request.pricingProvenance === null))
    throw new Error("Known cost requires dated pricing provenance; unknown cost has no price");
  validateUsageCategories(request.categories, request.inputSemantics, request.reasoningSemantics);
  return request;
}

/** Accumulate deltas or replace verified cumulative counters. Nulls retain only known lower bounds. */
export function accumulateRequestUsage(
  previous: RequestUsageTotals | null,
  request: RequestUsageObservation,
): RequestUsageTotals {
  const categories = {} as UsageCategories;
  const categoryCoverage = {} as CategoryCoverage;
  for (const key of REQUEST_USAGE_CATEGORIES) {
    const value = request.categories[key];
    const prior = previous?.categories[key] ?? null;
    if (request.counter.mode === "cumulative" && value !== null && prior !== null && value < prior)
      throw new Error("Usage cumulative counter decreased; a verified reset requires a new epoch");
    categories[key] =
      value === null ? prior : request.counter.mode === "cumulative" ? value : (prior ?? 0) + value;
    if (categories[key] !== null) token.parse(categories[key]);
    categoryCoverage[key] =
      categories[key] === null
        ? "unknown"
        : !hasIncompleteUsage(request.collection) &&
            value !== null &&
            (request.counter.mode === "cumulative" ||
              !previous ||
              previous.categoryCoverage[key] === "complete")
          ? "complete"
          : "partial";
  }
  // A partial counter is only a lower bound; comparing it as a total would invent certainty.
  const complete = Object.fromEntries(
    REQUEST_USAGE_CATEGORIES.map((key) => [
      key,
      categoryCoverage[key] === "complete" ? categories[key] : null,
    ]),
  ) as unknown as UsageCategories;
  validateUsageCategories(complete, request.inputSemantics, request.reasoningSemantics);
  usageTokenTotals(categories, request.reasoningSemantics);
  const cost =
    request.counter.mode === "cumulative" || !previous
      ? request.cost
      : previous.cost === null || request.cost === null
        ? null
        : previous.cost + request.cost;
  if (cost !== null && !Number.isFinite(cost)) throw new Error("Usage cost overflow");
  return { categories, categoryCoverage, cost };
}
