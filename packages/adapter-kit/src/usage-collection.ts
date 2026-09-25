import type { UsageCollection } from "@ardurbot/contracts";
import type {
  AgentRuntimeEvent,
  AgentUsage,
  RequestUsageObservation,
  UsageCategories,
  UsagePurpose,
} from "./types.js";

export type RawUsageCounts = UsageCollection["raw"];
export type UsageOutcome = UsageCollection["outcome"];
export type UsageLimitation = UsageCollection["limitations"][number];
/** These observations are lower bounds even when every numeric category was supplied. */
export function hasIncompleteUsage(
  collection: Pick<UsageCollection, "limitations"> | undefined,
): boolean {
  return (
    collection?.limitations.some((reason) =>
      [
        "invalid-provider-usage",
        "unverified-resume-boundary",
        "counter-discontinuity",
        "stream-ended-without-usage",
        "consumer-stopped",
        "late-usage-unverified",
      ].includes(reason),
    ) ?? false
  );
}
export const unknownUsageCategories = (): UsageCategories => ({
  logicalInput: null,
  uncachedInput: null,
  cacheReadInput: null,
  cacheWriteInput: null,
  output: null,
  reasoning: null,
});

/** Provider adapters project only their documented numeric fields into these canonical names. */
export function normalizeUsageCounts(
  values: Partial<Record<keyof RawUsageCounts, unknown>>,
  inputSemantics: RequestUsageObservation["inputSemantics"],
  reasoningSemantics: RequestUsageObservation["reasoningSemantics"] = "subset-of-output",
) {
  const raw: RawUsageCounts = {};
  let invalid = false;
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite1h",
    "reasoning",
    "total",
  ] as const) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 2_147_483_647
    )
      invalid = true;
    else raw[key] = value;
  }
  const input = raw.input ?? null;
  const read = raw.cacheRead ?? null;
  const write = raw.cacheWrite ?? null;
  const componentsKnown = input !== null && read !== null && write !== null;
  const additive = inputSemantics === "additive-cache-categories";
  const logical = additive ? (componentsKnown ? input + read + write : null) : input;
  const categories: UsageCategories = {
    logicalInput: logical,
    uncachedInput:
      inputSemantics === "unknown"
        ? null
        : additive
          ? input
          : componentsKnown
            ? input - read - write
            : null,
    cacheReadInput: inputSemantics === "unknown" ? null : read,
    cacheWriteInput: inputSemantics === "unknown" ? null : write,
    output: raw.output ?? null,
    reasoning: reasoningSemantics === "unknown" ? null : (raw.reasoning ?? null),
  };
  if (
    (logical !== null && (logical > 2_147_483_647 || (read ?? 0) + (write ?? 0) > logical)) ||
    (categories.reasoning !== null &&
      categories.output !== null &&
      reasoningSemantics === "subset-of-output" &&
      categories.reasoning > categories.output) ||
    (raw.cacheWrite1h !== undefined && write !== null && raw.cacheWrite1h > write) ||
    (logical ?? 0) +
      (categories.output ?? 0) +
      (reasoningSemantics === "separate" ? (categories.reasoning ?? 0) : 0) >
      2_147_483_647
  )
    invalid = true;
  return { raw, categories: invalid ? unknownUsageCategories() : categories, invalid };
}

/** One observable request/attempt. Snapshots replace counters; terminal receipts never rebill. */
export class RequestUsageCollector {
  private sequence = 0;
  private categories = unknownUsageCategories();
  private raw: RawUsageCounts = {};
  private outcome: UsageOutcome = "started";
  private limitations: UsageLimitation[];
  readonly requestId: string;
  readonly attemptId: string;
  constructor(
    private readonly options: {
      provider: string;
      model: string;
      mappingVersion: string;
      inputSemantics: RequestUsageObservation["inputSemantics"];
      reasoningSemantics?: RequestUsageObservation["reasoningSemantics"];
      scope?: UsageCollection["scope"];
      purpose?: UsagePurpose;
      requestId?: string;
      attemptId?: string;
      parentRequestId?: string | null;
      limitations?: UsageLimitation[];
    },
  ) {
    this.requestId = options.requestId ?? crypto.randomUUID();
    this.attemptId = options.attemptId ?? crypto.randomUUID();
    this.limitations = [...(options.limitations ?? [])];
  }
  start(raw?: RawUsageCounts): AgentUsage {
    if (raw) this.raw = normalizeUsageCounts(raw, "unknown", "unknown").raw;
    return this.event();
  }
  snapshot(
    values: Partial<Record<keyof RawUsageCounts, unknown>>,
    sourceRaw?: RawUsageCounts,
  ): AgentUsage {
    const mapped = normalizeUsageCounts(
      values,
      this.options.inputSemantics,
      this.options.reasoningSemantics,
    );
    this.raw = sourceRaw ? normalizeUsageCounts(sourceRaw, "unknown", "unknown").raw : mapped.raw;
    if (mapped.invalid) this.limit("invalid-provider-usage");
    else this.categories = mapped.categories;
    return this.event();
  }
  limit(reason: UsageLimitation) {
    if (!this.limitations.includes(reason)) this.limitations.push(reason);
  }
  finish(outcome: Exclude<UsageOutcome, "started">): AgentUsage {
    this.outcome = outcome;
    if (Object.values(this.categories).every((value) => value === null))
      this.limit("provider-omitted");
    return this.event();
  }
  private event(): AgentUsage {
    const reasoningSemantics = this.options.reasoningSemantics ?? "subset-of-output";
    const categories = { ...this.categories };
    const known = Object.values(categories).filter((value) => value !== null).length;
    return {
      provider: this.options.provider,
      model: this.options.model,
      inputTokens: categories.logicalInput ?? 0,
      outputTokens:
        (categories.output ?? 0) +
        (reasoningSemantics === "separate" ? (categories.reasoning ?? 0) : 0),
      reported: known > 0,
      ...(categories.cacheReadInput === null ? {} : { cachedTokens: categories.cacheReadInput }),
      request: {
        requestId: this.requestId,
        attemptId: this.attemptId,
        parentRequestId: this.options.parentRequestId ?? null,
        purpose: this.options.purpose ?? "main",
        counter: { mode: "cumulative", epochId: "0", sequence: this.sequence++ },
        inputSemantics: this.options.inputSemantics,
        reasoningSemantics,
        categories,
        cost: null,
        pricingProvenance: null,
        collection: {
          mappingVersion: this.options.mappingVersion,
          scope: this.options.scope ?? "request",
          outcome: this.outcome,
          availability:
            known === 0
              ? "unavailable"
              : known === 6 && !hasIncompleteUsage({ limitations: this.limitations })
                ? "reported"
                : "partial",
          raw: { ...this.raw },
          limitations: [...this.limitations],
        },
      },
    };
  }
}

export function usageEvent(usage: AgentUsage): Extract<AgentRuntimeEvent, { type: "usage" }> {
  return { type: "usage", ...usage };
}
