import { describe, expect, it } from "vitest";
import { rateLimitExperiment } from "./provider.js";

describe("shared-account retry schedules", () => {
  it("observes bounded same-model retries and the missing shared admission gate", async () => {
    const result = await rateLimitExperiment();
    expect(result.checks.attemptsObserved, JSON.stringify(result.measurements)).toBe(true);
    expect(result.checks.attemptCap, JSON.stringify(result.measurements)).toBe(true);
    expect(result.checks.sameProviderPin).toBe(true);
    expect(result.checks.authenticationNotRetried).toBe(true);
    expect(result.checks.retryAfterHonored, JSON.stringify(result.measurements)).toBe(true);
    // Two bots each retry after the reset window. That is not one shared admission budget.
    expect(result.checks.sharedAdmission).toBe(false);
    // A non-numeric Retry-After currently becomes an immediate retry.
    expect(result.checks.malformedRetryWasDeferred).toBe(false);
    expect(result.status).toBe("finding");
  }, 120_000);
});
