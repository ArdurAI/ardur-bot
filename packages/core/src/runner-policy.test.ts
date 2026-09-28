import { expect, test, describe } from "vitest";
import { evaluateRunnerPolicy } from "./runner-policy.js";
import { RunnerLimitsSchema } from "@ardurbot/contracts";

describe("evaluateRunnerPolicy", () => {
  const defaultLimits = RunnerLimitsSchema.parse({});
  const request = { runnerId: "r1", command: ["test"] };

  test("uses default 5 minute max duration when no time used", () => {
    const policy = evaluateRunnerPolicy(defaultLimits, request, 0);
    expect(policy.maxDurationMs).toBe(300000);
  });

  test("caps duration to remaining owner limit", () => {
    // 14 minutes used, 1 minute left
    const policy = evaluateRunnerPolicy(defaultLimits, request, 14 * 60 * 1000);
    expect(policy.maxDurationMs).toBe(60000); // 1 minute
  });

  test("throws when owner limit is exceeded", () => {
    expect(() => evaluateRunnerPolicy(defaultLimits, request, 15 * 60 * 1000)).toThrow(/limit exceeded/);
  });
});
