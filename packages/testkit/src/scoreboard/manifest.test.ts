import { describe, expect, it } from "vitest";
import {
  CRASH_BOUNDARIES,
  canonicalSerialize,
  contentDigest,
  createScoreboardManifest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  METRIC_FAMILIES,
  parseScoreboardManifest,
  SCOREBOARD_MANIFEST,
  TASK_DEFINITIONS,
} from "./manifest.js";

describe("scoreboard definition coverage", () => {
  it("registers every metric family, department task, opportunity and durable boundary", () => {
    expect(METRIC_FAMILIES.map((family) => family.name)).toEqual([
      "User TTFT",
      "Provider TTFT",
      "End-to-end turn time",
      "Prompt tokens per turn",
      "Cache hit ratio",
      "Compaction count and quality",
      "Tool latency",
      "Queue wait",
      "Desktop cold start",
      "Idle and peak memory",
      "Bundle and installer size",
      "Fixed-task success",
      "Reliability",
      "Battery and responsiveness",
    ]);
    expect(TASK_DEFINITIONS).toHaveLength(24);
    expect(
      Object.values(Object.groupBy(TASK_DEFINITIONS, (task) => task.department)).map(
        (group) => group?.length,
      ),
    ).toEqual([4, 4, 4, 4, 4, 4]);
    expect(TASK_DEFINITIONS.map((task) => task.name)).toEqual([
      "Policy lookup",
      "Case timeline",
      "Entitlement reconciliation",
      "Approved case update",
      "Account brief",
      "Duplicate-record detection",
      "Quote calculation",
      "Draft follow-up",
      "Invoice matching",
      "Expense-policy check",
      "CSV variance report",
      "Approval routing",
      "Onboarding checklist",
      "Leave-policy answer",
      "Training-record reconciliation",
      "Meeting conflict resolution",
      "Multi-document brief",
      "Conflicting-source analysis",
      "Chart extraction",
      "Delegated group brief",
      "Small repository repair",
      "Shell diagnosis",
      "Configuration comparison",
      "Interrupted workspace task",
    ]);
    expect(EXPERIMENT_DEFINITIONS.map((experiment) => experiment.id)).toEqual([
      "O1",
      "O2",
      "O3",
      "O4",
      "O5",
      "O6",
      "O7",
      "O8",
      "O9",
      "O10",
      "O11",
      "O12",
      "O13",
    ]);
    expect(CRASH_BOUNDARIES.map((boundary) => boundary.name)).toEqual([
      "Admission committed before enqueue",
      "Lease acquired before work",
      "Intent persisted before action",
      "External action completed before receipt",
      "Result persisted before terminal state",
      "Terminal state committed before UI delivery",
      "Pending approval",
      "Compaction commit",
      "Memory delivery",
      "Native host disconnect",
    ]);
    expect(new Set(METRIC_DEFINITIONS.map((metric) => metric.id)).size).toBe(
      METRIC_DEFINITIONS.length,
    );
    expect(METRIC_DEFINITIONS.every((metric) => metric.requiredCoverage === 1)).toBe(true);
  });

  it("retains tiers, calibrated-gate boundary, sample plans and conditional features", () => {
    expect(Object.keys(SCOREBOARD_MANIFEST.tiers)).toEqual(["T0", "T1", "T2", "T3"]);
    expect(SCOREBOARD_MANIFEST.samplePlan).toMatchObject({
      commitPairs: 20,
      releaseReplayPairs: 200,
      releaseStartupObservationsPerStratum: 100,
      stabilizedIdleMinutes: 15,
      quietIntervalMinutes: 30,
      mixedSoakMinutes: 120,
    });
    expect(SCOREBOARD_MANIFEST.proposedGates.status).toBe("uncalibrated");
    expect(SCOREBOARD_MANIFEST.proposedGates.latency).toMatchObject({
      releaseRelative: 0.1,
      releaseAbsoluteMs: 25,
      combination: "max",
    });
    expect(SCOREBOARD_MANIFEST.proposedGates.promptTokens).toEqual({
      relative: 0.05,
      absolute: 128,
      combination: "max",
    });
    expect(EXPERIMENT_DEFINITIONS.find((item) => item.id === "O11")?.conditionalVariants).toContain(
      "checkpointed-workspace",
    );
    expect(EXPERIMENT_DEFINITIONS.find((item) => item.id === "O13")?.implementation).toBe(
      "not-implemented",
    );
  });
});

describe("canonical local manifest", () => {
  it("has stable UTF-8 JSON bytes, a known digest, ordered arrays and significant changes", () => {
    expect(canonicalSerialize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(contentDigest({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(contentDigest({ a: ["é", 0], b: null })).toBe(contentDigest({ b: null, a: ["é", 0] }));
    expect(contentDigest([1, 2])).not.toBe(contentDigest([2, 1]));
    expect(contentDigest({ a: 0 })).not.toBe(contentDigest({ a: null }));
    expect(canonicalSerialize(JSON.parse('{"__proto__":{"x":1},"constructor":0}'))).toBe(
      '{"__proto__":{"x":1},"constructor":0}',
    );
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    () => 1,
    new Date(),
    new Map(),
    { a: undefined },
    [undefined],
    Array(1),
    { a: Symbol("x") },
    { [Symbol("x")]: 1 },
  ])("rejects lossy non-JSON input %#", (value) => {
    expect(() => canonicalSerialize(value)).toThrow();
  });

  it("rejects cycles and accessors without executing them", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalSerialize(cycle)).toThrow("acyclic");
    let invoked = false;
    expect(() =>
      canonicalSerialize({
        get value() {
          invoked = true;
          return 1;
        },
      }),
    ).toThrow("accessors");
    expect(invoked).toBe(false);
  });

  it("returns an immutable snapshot and resists caller mutation across consumers", () => {
    const original = structuredClone(createScoreboardManifest());
    const first = parseScoreboardManifest(original);
    original.manifest.tasks.pop();
    expect(first.manifest.tasks).toHaveLength(24);
    expect(() => first.manifest.tasks.pop()).toThrow();
    expect(() => parseScoreboardManifest(original)).toThrow("checksum");
    expect(parseScoreboardManifest(createScoreboardManifest()).sha256).toBe(first.sha256);
  });

  it.each(["families", "tasks", "experiments", "crashBoundaries"] as const)(
    "rejects removed or duplicated %s even with a recomputed checksum",
    (key) => {
      const removed = structuredClone(SCOREBOARD_MANIFEST);
      removed[key].pop();
      expect(() =>
        parseScoreboardManifest({ manifest: removed, sha256: contentDigest(removed) }),
      ).toThrow("incomplete");
      const duplicate = structuredClone(SCOREBOARD_MANIFEST);
      duplicate[key].push(duplicate[key][0] as never);
      expect(() =>
        parseScoreboardManifest({ manifest: duplicate, sha256: contentDigest(duplicate) }),
      ).toThrow("incomplete");
    },
  );

  it("rejects changed definitions, unsupported versions and extra envelope fields", () => {
    const altered = structuredClone(SCOREBOARD_MANIFEST);
    altered.families[0]!.metrics[0]!.unit = "bytes";
    expect(() =>
      parseScoreboardManifest({ manifest: altered, sha256: contentDigest(altered) }),
    ).toThrow("Unsupported");
    altered.schemaVersion = 99;
    expect(() =>
      parseScoreboardManifest({ manifest: altered, sha256: contentDigest(altered) }),
    ).toThrow("Unsupported");
    expect(() => parseScoreboardManifest({ ...createScoreboardManifest(), extra: true })).toThrow(
      "envelope",
    );
  });
});

describe("canonical serialization failure controls", () => {
  it("rejects array accessors without invoking them and refuses hidden data", () => {
    let invoked = false;
    const array = [1];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    expect(() => canonicalSerialize(array)).toThrow("accessors");
    expect(invoked).toBe(false);
    const object = Object.defineProperty({}, "hidden", { value: 1 });
    expect(() => canonicalSerialize(object)).toThrow("Non-enumerable");
    const extended = Object.assign([1], { extra: 2 });
    expect(() => canonicalSerialize(extended)).toThrow("extended");
  });
});
