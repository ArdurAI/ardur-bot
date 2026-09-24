import { describe, expect, it } from "vitest";
import { timingWarnings } from "./performance-budget.mjs";

const baseline = {
  kind: "offline-proxy",
  machine: { platform: "fixture" },
  metrics: { shell: 10, token: 2 },
};
describe("advisory timing budgets", () => {
  it("warns only above twenty percent and reports every regressed metric", () => {
    expect(timingWarnings(baseline, { ...baseline, metrics: { shell: 12, token: 2.4 } })).toEqual(
      [],
    );
    expect(
      timingWarnings(baseline, { ...baseline, metrics: { shell: 12.1, token: 2.5 } }),
    ).toHaveLength(2);
  });
  it("does not pretend measurements from different machines are comparable", () => {
    expect(timingWarnings(baseline, { ...baseline, machine: { platform: "other" } })[0]).toContain(
      "environments differ",
    );
  });
});
