import { describe, expect, it } from "vitest";
import { EVIDENCE_STATES, evidenceState } from "./evidence-states.js";

describe("evidence state rules", () => {
  const facts = {
    recordCount: 3,
    finished: true,
    sealed: true,
    verificationFailed: false,
    gapCount: 0,
  };
  it.each([
    ["off", { recordCount: 0, sealed: false }],
    ["recording", { finished: false, sealed: false }],
    ["verified", {}],
    ["gap", { gapCount: 2 }],
    ["unsealed", { sealed: false }],
    ["failed", { verificationFailed: true }],
  ] as const)("computes %s from one table", (state, changes) => {
    expect(evidenceState({ ...facts, ...changes })).toBe(state);
    expect(EVIDENCE_STATES[state].labelMessageId).not.toBe("");
    expect(EVIDENCE_STATES[state].icon).not.toBe("");
  });
  it("does not hide total recording loss as off", () => {
    expect(evidenceState({ ...facts, recordCount: 0, sealed: false, gapCount: 1 })).toBe(
      "unsealed",
    );
  });
  it("never describes corrupt running or gap evidence as verified", () => {
    expect(
      evidenceState({ ...facts, finished: false, gapCount: 2, verificationFailed: true }),
    ).toBe("failed");
  });
});
