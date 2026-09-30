import { describe, expect, it } from "vitest";
import { ProviderErrorKindSchema } from "./provider-errors.js";
import {
  PROVIDER_RETRY_POLICY,
  ProviderRetryRuleSchema,
  providerRetryWaitMs,
} from "./provider-retry.js";

const NO_JITTER = () => 0;

describe("provider retry policy", () => {
  it("has a valid rule for every provider error kind", () => {
    for (const kind of ProviderErrorKindSchema.options) {
      const rule = PROVIDER_RETRY_POLICY[kind];
      expect(rule, kind).toBeDefined();
      expect(ProviderRetryRuleSchema.safeParse(rule).success, kind).toBe(true);
    }
  });

  it("retries a rate limit three times with a growing wait, then stops", () => {
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 1, random: NO_JITTER })).toBe(2_000);
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 2, random: NO_JITTER })).toBe(6_000);
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 3, random: NO_JITTER })).toBe(
      18_000,
    );
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 4, random: NO_JITTER })).toBeNull();
  });

  it("never waits for a kind that does not retry", () => {
    for (const kind of ["model-unavailable", "auth", "other"] as const) {
      expect(providerRetryWaitMs({ kind, attempt: 1, random: NO_JITTER })).toBeNull();
    }
  });

  it("refuses attempts outside the retry count", () => {
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 0, random: NO_JITTER })).toBeNull();
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: -1, random: NO_JITTER })).toBeNull();
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 1.5, random: NO_JITTER })).toBeNull();
  });

  it("caps the backoff at the rule's longest wait", () => {
    // Attempt 3 would be 18s; a higher first wait would land above the 30s cap.
    const rule = PROVIDER_RETRY_POLICY["rate-limit"];
    const uncapped = rule.firstWaitMs * rule.factor ** 2;
    expect(uncapped).toBeLessThanOrEqual(rule.maxWaitMs);
  });

  it("uses the wait the provider asks for, capped at the honour bound", () => {
    expect(
      providerRetryWaitMs({ kind: "rate-limit", attempt: 1, providerWaitMs: 5_000, random: NO_JITTER }),
    ).toBe(5_000);
    expect(
      providerRetryWaitMs({
        kind: "rate-limit",
        attempt: 1,
        providerWaitMs: 90_000,
        random: NO_JITTER,
      }),
    ).toBe(60_000);
    // A provider wait still counts against the retries.
    expect(
      providerRetryWaitMs({ kind: "rate-limit", attempt: 4, providerWaitMs: 5_000, random: NO_JITTER }),
    ).toBeNull();
  });

  it("keeps the added randomness inside a quarter of the wait", () => {
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 1, random: () => 0.5 })).toBe(2_250);
    expect(providerRetryWaitMs({ kind: "rate-limit", attempt: 1, random: () => 1 })).toBe(2_500);
    const wait = providerRetryWaitMs({
      kind: "rate-limit",
      attempt: 2,
      providerWaitMs: 10_000,
      random: () => 0.25,
    });
    expect(wait).toBeGreaterThanOrEqual(10_000);
    expect(wait).toBeLessThanOrEqual(12_500);
  });
});
