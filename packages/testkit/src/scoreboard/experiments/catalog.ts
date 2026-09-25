import { CRASH_BOUNDARIES, EXPERIMENT_DEFINITIONS, SCOREBOARD_MANIFEST } from "../manifest.js";

export type MatrixPlan = "smoke" | "commit" | "nightly" | "release";
export type ExperimentId = (typeof EXPERIMENT_DEFINITIONS)[number]["id"];
export type CrashId = (typeof CRASH_BOUNDARIES)[number]["id"];
export type CoverageStatus = "applicable" | "incomplete" | "feature-not-implemented";

/** Ownership augments the frozen W0-1 registry; no experiment or variant is removed. */
export const EXPERIMENT_OWNERS = {
  O1: ["W0-8", "W0-9"],
  O2: ["W0-6", "W0-7", "W1-10"],
  O3: ["W0-6", "W1-6", "Chief of Staff"],
  O4: ["W0-6", "W1-5"],
  O5: ["W0-6", "W1-2"],
  O6: ["W0-6", "W1-3", "robust integrations"],
  O7: ["W0-6", "Chief of Staff", "fleet"],
  O8: ["W0-6", "robust integrations"],
  O9: ["W0-6"],
  O10: ["W0-6", "W1-9", "robust integrations"],
  O11: ["W0-6", "fleet"],
  O12: ["W0-7"],
  O13: ["W0-7", "fleet"],
} as const satisfies Record<ExperimentId, readonly string[]>;

export const MATRIX_PARAMETERS = {
  documents: [100, 1000, 10000],
  revisions: [1, 20],
  connectors: [0, 10, 50],
  demands: [1, 4, 16],
  arrivals: ["open-loop", "fixed-concurrency"],
  workerConcurrency: 4,
  seed: 606,
  deadlineMs: 15000,
  documentBytes: 256,
} as const;

export function matrixPlan(plan: MatrixPlan) {
  if (!["smoke", "commit", "nightly", "release"].includes(plan))
    throw new Error("Unknown matrix plan");
  const expanded = plan === "nightly" || plan === "release";
  return {
    name: plan,
    seed: MATRIX_PARAMETERS.seed,
    workerConcurrency: MATRIX_PARAMETERS.workerConcurrency,
    deadlineMs: MATRIX_PARAMETERS.deadlineMs,
    // Smoke is correctness evidence. It must never satisfy the timing/release sample plan.
    requiredComparisonPairs:
      plan === "release"
        ? SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs
        : plan === "smoke"
          ? 1
          : 20,
    executionPasses: 1,
    observedComparisonPairs: 0,
    faults: CRASH_BOUNDARIES.map((boundary) => ({ ...boundary })),
    memory: (expanded ? MATRIX_PARAMETERS.documents : [100]).flatMap((documents) =>
      (expanded ? MATRIX_PARAMETERS.revisions : [1]).map((revisions) => ({ documents, revisions })),
    ),
    connectors: expanded ? [...MATRIX_PARAMETERS.connectors] : [0, 10],
    load: (expanded ? MATRIX_PARAMETERS.demands : [1, 4]).flatMap((demands) =>
      MATRIX_PARAMETERS.arrivals.map((arrival) => ({ demands, arrival })),
    ),
    timingClaim: false,
    releaseEligible: false,
  };
}

export function experimentCoverage() {
  return EXPERIMENT_DEFINITIONS.map((definition) => ({
    id: definition.id,
    owners: EXPERIMENT_OWNERS[definition.id as keyof typeof EXPERIMENT_OWNERS],
    variants: definition.variants,
    guardrails: definition.guardrails,
    status: (definition.id === "O13" ? "feature-not-implemented" : "incomplete") as CoverageStatus,
    reason:
      definition.id === "O13"
        ? "No startup snapshot implementation; normal initialization remains the fallback."
        : definition.id === "O12"
          ? "W0-7 owns packaged startup, physical energy and platform acceptance."
          : definition.id === "O1"
            ? "W0-8 owns comparator validation; W0-9 owns immutable release indexing."
            : "Selected cases do not close every declared variant, guardrail and tier.",
  }));
}

export interface MatrixResult {
  id: string;
  experiment: ExperimentId;
  tier: "T0" | "T1";
  status: "passed" | "finding" | "incomplete";
  checks: Record<string, boolean>;
  measurements: Record<string, unknown>;
  coverage: string[];
  gaps: string[];
}

export function matrixExitCode(results: readonly MatrixResult[], release: boolean): 0 | 1 | 2 {
  if (
    results.some(
      (result) => result.status === "finding" || Object.values(result.checks).includes(false),
    )
  )
    return 1;
  if (!results.length || release || results.some((result) => result.status === "incomplete"))
    return 2;
  return 0;
}
