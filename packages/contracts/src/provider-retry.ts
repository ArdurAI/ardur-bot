import { z } from "zod";
import type { ProviderErrorKind } from "./provider-errors.js";

/**
 * How one kind of provider refusal is retried before a run gives up. The policy is
 * PROVIDER_RETRY_POLICY below: to change when runs wait and try again, change that
 * one table, nowhere else.
 */
export const ProviderRetryRuleSchema = z.object({
  /** Refusals retried before the run fails with the provider's reason. */
  retries: z.number().int().min(0).max(5),
  /** Wait before the first retry, in milliseconds. */
  firstWaitMs: z.number().int().min(0),
  /** Each later retry waits this many times the previous wait. */
  factor: z.number().min(1),
  /** The longest wait between retries, in milliseconds. */
  maxWaitMs: z.number().int().min(0),
  /** A wait the provider itself asks for is honoured up to this many milliseconds. */
  honourProviderWaitUpToMs: z.number().int().min(0),
});
export type ProviderRetryRule = z.infer<typeof ProviderRetryRuleSchema>;

const PROVIDER_NO_RETRY: ProviderRetryRule = {
  retries: 0,
  firstWaitMs: 0,
  factor: 1,
  maxWaitMs: 0,
  honourProviderWaitUpToMs: 0,
};

/**
 * The one place the retry policy lives. A rate limit is the provider saying "not now",
 * so a run refused for too many requests waits a moment and tries again; every other
 * refusal is final.
 */
export const PROVIDER_RETRY_POLICY: Record<ProviderErrorKind, ProviderRetryRule> = {
  "rate-limit": {
    retries: 3,
    firstWaitMs: 2_000,
    factor: 3,
    maxWaitMs: 30_000,
    honourProviderWaitUpToMs: 60_000,
  },
  "model-unavailable": PROVIDER_NO_RETRY,
  auth: PROVIDER_NO_RETRY,
  other: PROVIDER_NO_RETRY,
};

/**
 * The wait before retry number `attempt` (1 is the first retry), or null when the kind
 * does not retry or the retries are used up. A wait the provider asks for is used
 * instead, capped at the rule's honour bound. Up to 25 percent of randomness is added
 * from the given `random`, so bots refused in the same moment do not return together.
 */
export function providerRetryWaitMs(input: {
  kind: ProviderErrorKind;
  attempt: number;
  providerWaitMs?: number;
  random: () => number;
}): number | null {
  const rule = PROVIDER_RETRY_POLICY[input.kind];
  if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > rule.retries) {
    return null;
  }
  const backoff = Math.min(rule.firstWaitMs * rule.factor ** (input.attempt - 1), rule.maxWaitMs);
  const base =
    input.providerWaitMs != null
      ? Math.min(Math.max(input.providerWaitMs, 0), rule.honourProviderWaitUpToMs)
      : backoff;
  return Math.round(base * (1 + 0.25 * input.random()));
}
