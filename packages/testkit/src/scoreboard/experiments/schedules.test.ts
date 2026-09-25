import { createStreamingRedactor, redactSecrets } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import {
  GOLD_PROBES,
  GOLD_SUMMARY,
  gradeGoldProbes,
  RATE_SCENARIOS,
  rateSchedule,
  STREAM_SCENARIOS,
  STREAM_TEXT,
  SYNTHETIC_SECRET,
  seededRandom,
  streamSchedule,
} from "./schedules.js";

describe("fault schedules and independent oracles", () => {
  it.each(STREAM_SCENARIOS)(
    "retains UTF-8 bytes and redacts a secret across %s fragments",
    (scenario) => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const redactor = createStreamingRedactor([SYNTHETIC_SECRET]);
      let output = "";
      for (const item of streamSchedule(scenario)) {
        output += redactor.push(decoder.decode(item.bytes, { stream: true }));
        expect(output).not.toContain(SYNTHETIC_SECRET);
      }
      output += redactor.push(decoder.decode()) + redactor.finish();
      expect(output).toBe(redactSecrets(STREAM_TEXT, [SYNTHETIC_SECRET]));
      expect(output).toContain("café 🧪");
    },
  );
  it("detects critical negation, supersession, approval and source corruption", () => {
    expect(Object.values(gradeGoldProbes(GOLD_SUMMARY)).every(Boolean)).toBe(true);
    for (const key of Object.keys(GOLD_PROBES)) {
      const changed = { ...GOLD_PROBES, [key]: "The words overlap but the conclusion is wrong." };
      expect(gradeGoldProbes(JSON.stringify(changed))[key]).toBe(false);
    }
    expect(Object.values(gradeGoldProbes(GOLD_SUMMARY.slice(0, -1))).every(Boolean)).toBe(false);
    expect(Object.values(gradeGoldProbes("null")).every(Boolean)).toBe(false);
  });
  it.each(RATE_SCENARIOS)("reproduces bounded injected jitter for %s", (scenario) => {
    const first = rateSchedule(scenario, 606);
    expect(first).toEqual(rateSchedule(scenario, 606));
    expect(first.jitterMs).not.toEqual(rateSchedule(scenario, 607).jitterMs);
    expect(first.jitterMs.every((value) => value >= 0 && value <= 10)).toBe(true);
  });
  it("retains reset, zero, malformed, auth and quota failures as separate schedules", () => {
    expect(rateSchedule("retry-after-zero", 1).headers["retry-after"]).toBe("0");
    expect(rateSchedule("retry-after-malformed", 1).headers["retry-after"]).toBe("not-a-number");
    expect(rateSchedule("authentication-failure", 1).status).toBe(401);
    expect(rateSchedule("quota-exhaustion", 1).code).toBe("insufficient_quota");
    expect(() => seededRandom(Number.NaN)).toThrow();
    expect(() => seededRandom(-1)).toThrow();
  });
});
