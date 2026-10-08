import { describe, expect, it } from "vitest";
import { COMPUTER_LIMITS_MAX_AGE_MS, currentComputerLimits } from "./computer-limits.js";

describe("computer limits freshness", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const observation = {
    observedAt: new Date(now).toISOString(),
    cpuCores: 1.5,
    memoryBytes: null,
    processes: null,
  };
  it("accepts the age boundary and rejects stale, future and malformed observations", () => {
    expect(currentComputerLimits(observation, now + COMPUTER_LIMITS_MAX_AGE_MS)).toEqual(
      observation,
    );
    expect(currentComputerLimits(observation, now + COMPUTER_LIMITS_MAX_AGE_MS + 1)).toBeNull();
    expect(currentComputerLimits(observation, now - 1)).toBeNull();
    expect(currentComputerLimits({ ...observation, cpuCores: -1 }, now)).toBeNull();
    expect(
      currentComputerLimits({ ...observation, memoryBytes: Number.MAX_SAFE_INTEGER + 1 }, now),
    ).toBeNull();
    expect(currentComputerLimits(undefined, now)).toBeNull();
  });
});
