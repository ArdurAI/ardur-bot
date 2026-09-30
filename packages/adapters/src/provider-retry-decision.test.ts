import { describe, expect, it } from "vitest";
import { ProviderError } from "./provider-error.js";
import { shouldRetryProviderFailure } from "./provider-retry-decision.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const NO_JITTER = () => 0;

function decision(input: Partial<Parameters<typeof shouldRetryProviderFailure>[0]>) {
  return shouldRetryProviderFailure({
    error: new ProviderError("Too many requests", "rate-limit"),
    shown: false,
    cancelRequested: false,
    attemptsSoFar: 0,
    deadlineAt: null,
    now: NOW,
    random: NO_JITTER,
    ...input,
  });
}

describe("shouldRetryProviderFailure", () => {
  it("waits and names the next attempt for a rate limit that has shown nothing", () => {
    expect(decision({})).toEqual({ waitMs: 2_000, attempt: 1 });
  });

  it("counts the retries already taken", () => {
    expect(decision({ attemptsSoFar: 2 })).toEqual({ waitMs: 18_000, attempt: 3 });
  });

  it("stops when the retries are used up", () => {
    expect(decision({ attemptsSoFar: 3 })).toBeNull();
  });

  it("does not retry a failure that is not a provider refusal", () => {
    expect(decision({ error: new Error("Too many requests") })).toBeNull();
    expect(decision({ error: "rate limit" })).toBeNull();
  });

  it("does not retry a refusal whose kind has no retries", () => {
    expect(decision({ error: new ProviderError("Unauthorized", "auth") })).toBeNull();
    expect(
      decision({ error: new ProviderError("Unknown model", "model-unavailable") }),
    ).toBeNull();
    expect(decision({ error: new ProviderError("Boom", "other") })).toBeNull();
  });

  it("does not retry once the run has shown anything", () => {
    expect(decision({ shown: true })).toBeNull();
  });

  it("does not retry a run that was asked to stop", () => {
    expect(decision({ cancelRequested: true })).toBeNull();
  });

  it("retries only when the wait ends before the run's deadline", () => {
    expect(decision({ deadlineAt: new Date(NOW.getTime() + 5_000) })).toEqual({
      waitMs: 2_000,
      attempt: 1,
    });
    expect(decision({ deadlineAt: new Date(NOW.getTime() + 1_000) })).toBeNull();
    expect(decision({ attemptsSoFar: 2, deadlineAt: new Date(NOW.getTime() + 10_000) })).toBeNull();
  });

  it("adds up to a quarter of randomness so refused bots do not return together", () => {
    expect(decision({ random: () => 1 })).toEqual({ waitMs: 2_500, attempt: 1 });
  });
});
