import { describe, expect, it } from "vitest";
import { legacyTimingVerdict, performanceVerdict, timingWarnings } from "./performance-budget.mjs";

const baseline = {
  kind: "offline-proxy",
  machine: { platform: "fixture" },
  metrics: { shell: 1000, token: 100 },
  samples: 20,
};
describe("advisory timing budgets", () => {
  it("warns only above both five percent and 25 ms and reports every regressed metric", () => {
    expect(timingWarnings(baseline, { ...baseline, metrics: { shell: 1050, token: 125 } })).toEqual(
      [],
    );
    expect(
      timingWarnings(baseline, { ...baseline, metrics: { shell: 1051, token: 126 } }),
    ).toHaveLength(2);
  });
  it("does not pretend measurements from different machines are comparable", () => {
    expect(timingWarnings(baseline, { ...baseline, machine: { platform: "other" } })[0]).toContain(
      "environments differ",
    );
  });
  it.each([-1, NaN, Infinity, null])("rejects invalid legacy durations %s", (value) => {
    expect(
      legacyTimingVerdict(baseline, {
        ...baseline,
        metrics: { shell: value, token: 100 },
      }).reasons.some((reason) => reason.code === "invalid-value"),
    ).toBe(true);
  });
  it("requires exactly the same nonempty keys", () => {
    for (const metrics of [{}, { shell: 1000 }, { ...baseline.metrics, extra: 1 }])
      expect(
        legacyTimingVerdict(baseline, { ...baseline, metrics }).reasons.some(
          (reason) => reason.code === "metric-key-mismatch",
        ),
      ).toBe(true);
    expect(
      legacyTimingVerdict({ ...baseline, metrics: {} }, { ...baseline, metrics: {} }).exitCode,
    ).toBe(2);
  });
  it("keeps zero measurements valid but rejects zero sample counts", () => {
    expect(timingWarnings(baseline, { ...baseline, metrics: { shell: 0, token: 0 } })).toEqual([]);
    expect(
      legacyTimingVerdict(baseline, { ...baseline, samples: 0 }).reasons.some(
        (reason) => reason.code === "invalid-sample-count",
      ),
    ).toBe(true);
  });
  it("retains the browser writer's raw launch-sample array without upgrading it to release evidence", () => {
    const browser = { ...baseline, kind: "browser-proxy", samples: [0, 10, 20, 30, 40] };
    expect(timingWarnings(browser, browser)).toEqual([]);
    expect(legacyTimingVerdict(browser, browser).exitCode).toBe(2);
    for (const samples of [[], [NaN], [-1]]) {
      expect(
        legacyTimingVerdict(browser, { ...browser, samples }).reasons.some(
          (reason) => reason.code === "invalid-sample-count",
        ),
      ).toBe(true);
    }
  });
  it("cannot turn historical or unsupported reports into release passes", async () => {
    expect((await performanceVerdict({ parent: baseline, candidate: baseline })).exitCode).toBe(2);
    expect(
      (await performanceVerdict({ parent: { schemaVersion: 99 }, candidate: {} })).exitCode,
    ).toBe(2);
  });
  it("compares nested machine metadata without depending on object key order", () => {
    const machine = { platform: "fixture", resources: { cpu: 4, memory: 8192 } };
    expect(
      timingWarnings(
        { ...baseline, machine },
        { ...baseline, machine: { resources: { memory: 8192, cpu: 4 }, platform: "fixture" } },
      ),
    ).toEqual([]);
    expect(
      legacyTimingVerdict(
        { ...baseline, machine },
        { ...baseline, machine: { ...machine, resources: { cpu: 8, memory: 8192 } } },
      ).reasons.some((reason) => reason.code === "environment-mismatch"),
    ).toBe(true);
    expect(legacyTimingVerdict("invalid", null).exitCode).toBe(2);
  });
  it.each([1, 2])(
    "retains schema %s desktop readers without inventing paired measurements",
    async (schemaVersion) => {
      const numeric = { count: 1, min: 1, median: 1, p95: 1, max: 1 };
      const historical = {
        schemaVersion,
        label: "synthetic",
        environment: {},
        summary: {
          cacheColdShellUsableMs: numeric,
          warmShellUsableMs: numeric,
          typingKeyPaintMs: numeric,
          idleCpuPercent: numeric,
          idleSummedPrivateKiB: numeric,
          idleSummedWorkingSetKiB: numeric,
          streamingCpuPercent: numeric,
          settingsPaintedMs: 1,
          settingsSettledMs: 1,
          reopenMs: null,
          hiddenSummedWorkingSetKiB: null,
        },
      };
      const result = await performanceVerdict({ parent: historical, candidate: historical });
      expect(result.exitCode).toBe(2);
      expect(result.reasons[0].code).toBe("legacy-unpaired-summary");
    },
  );
});
