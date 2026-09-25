import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TraceBoundary } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { createTraceBuffer } from "../../../../adapters/src/scoreboard-trace.js";
import { CRASH_BOUNDARIES, contentDigest, EXPERIMENT_DEFINITIONS } from "../manifest.js";
import { collectTraceEvidence, LOCAL_TRACE_BOUNDARIES } from "../trace-collector.js";
import type { MatrixResult } from "./catalog.js";
import { experimentCoverage, matrixExitCode, matrixPlan } from "./catalog.js";
import { matrixEvidence, writeMatrixArtifact, writeMatrixEvidence } from "./evidence.js";
import { classifyMemoryScale } from "./memory.js";

/** Adds the trace each fault-worker phase reports for one durable run. */
function traced(result: MatrixResult, run: string): MatrixResult {
  const earlier = LOCAL_TRACE_BOUNDARIES.filter((boundary) => boundary !== "terminal.committed");
  return {
    ...result,
    measurements: {
      ...result.measurements,
      before: {
        trace: phaseTrace(`${run}-interrupted`, run, earlier, LOCAL_TRACE_BOUNDARIES),
      },
      after: {
        ...(result.measurements.after as object),
        trace: phaseTrace(`${run}-recovered`, run, ["terminal.committed"], LOCAL_TRACE_BOUNDARIES),
      },
    },
  };
}

function crashAttempt(
  id: "crash-03" | "crash-04",
  measurements: MatrixResult["measurements"],
): MatrixResult {
  return {
    id,
    experiment: "O9",
    tier: "T1",
    status: "passed",
    checks: { killedAtBoundary: true, noDuplicateEffect: true },
    measurements,
    coverage: [],
    gaps: [],
  };
}
function phaseTrace(
  processId: string,
  run: string,
  points: readonly TraceBoundary[],
  recorded: readonly TraceBoundary[],
  options: { capacity?: number } = {},
) {
  const buffer = createTraceBuffer({
    processId,
    capacity: options.capacity,
    now: () => 1,
  });
  let at = 0;
  for (const boundary of points) {
    const operation =
      boundary.startsWith("provider.") || boundary.startsWith("tool.")
        ? { operationId: boundary.startsWith("tool.") ? "tool-1" : "provider-1", attempt: 0 }
        : {};
    buffer.record(
      run,
      boundary,
      boundary === "terminal.committed" ? { outcome: "success" } : operation,
      at,
    );
    at += 1;
  }
  if (options.capacity !== undefined && points.length > options.capacity)
    expect(buffer.snapshot().counters.dropped).toBe(points.length - options.capacity);
  return {
    ...collectTraceEvidence([buffer.snapshot()], {
      sessionId: "matrix-fault",
      pairId: null,
      requiredBoundaries: recorded,
    }),
    requiredBoundaries: [...recorded],
  };
}
describe("matrix selection and evidence", () => {
  it("keeps absent canonical crash results unknown and observed safety failures failed", () => {
    const empty = matrixEvidence([]);
    expect(empty.experiments).toHaveLength(13);
    expect(empty.crashes).toHaveLength(10);
    expect(empty.crashes.every((row) => row.safetyPassed === null && row.recovery === null)).toBe(
      true,
    );
    const failed = matrixEvidence([
      {
        id: "crash-04",
        experiment: "O9",
        tier: "T1",
        status: "finding",
        checks: { killedAtBoundary: true, noDuplicateEffect: false },
        measurements: {},
        coverage: [],
        gaps: [],
      },
    ]);
    expect(failed.crashes[3]).toMatchObject({
      status: "incomplete",
      missingReason: "invalid-trial",
      safetyPassed: false,
      recovery: null,
      taskCompleted: null,
    });
  });
  it("folds a failed revoke or pin control into that crash's safety result", () => {
    const passed = {
      id: "crash-03",
      experiment: "O9" as const,
      tier: "T1" as const,
      status: "passed" as const,
      checks: { killedAtBoundary: true, noUnauthorizedEffect: true },
      measurements: { after: { autonomousCompletion: true } },
      coverage: [],
      gaps: [],
    };
    const crash03 = (results: Parameters<typeof matrixEvidence>[0]) =>
      matrixEvidence(results).crashes.find((row) => row.id === "crash-03");
    expect(crash03([passed])).toMatchObject({
      status: "incomplete",
      missingReason: "missing-revoke-and-pin-controls",
      safetyPassed: null,
    });
    expect(crash03([passed, { ...passed, id: "crash-03-revoke" }])).toMatchObject({
      status: "incomplete",
      missingReason: "missing-pin-control",
      safetyPassed: null,
    });
    expect(crash03([passed, { ...passed, id: "crash-03-pin" }])).toMatchObject({
      status: "incomplete",
      missingReason: "missing-revoke-control",
      safetyPassed: null,
    });
    expect(
      crash03([
        passed,
        {
          ...passed,
          id: "crash-03-revoke",
          status: "finding",
          checks: { killedAtBoundary: true, noUnauthorizedEffect: false },
        },
      ])?.safetyPassed,
    ).toBe(false);
    // An incomplete control observed nothing: vacuous checks are neither safe nor a failure.
    expect(
      crash03([passed, { ...passed, id: "crash-03-pin", status: "incomplete", checks: {} }]),
    ).toMatchObject({
      status: "incomplete",
      missingReason: "missing-revoke-and-pin-controls",
      safetyPassed: null,
    });
    expect(
      crash03([passed, { ...passed, id: "crash-03-revoke" }, { ...passed, id: "crash-03-pin" }]),
    ).toMatchObject({
      status: "incomplete",
      missingReason: "trace-links-missing",
      safetyPassed: null,
    });
    expect(
      crash03([
        traced(passed, "run-base"),
        traced({ ...passed, id: "crash-03-revoke" }, "run-revoke"),
        traced({ ...passed, id: "crash-03-pin" }, "run-pin"),
      ]),
    ).toMatchObject({
      status: "complete",
      missingReason: null,
      recovery: "safe-retry",
      safetyPassed: true,
      taskCompleted: true,
    });
    // The base attempt never reached its boundary. A failed pin control is still a failure.
    expect(
      crash03([
        { ...passed, status: "incomplete", checks: { killedAtBoundary: false } },
        {
          ...passed,
          id: "crash-03-pin",
          status: "finding",
          checks: { killedAtBoundary: true, noWrongPin: false },
        },
      ]),
    ).toMatchObject({
      status: "incomplete",
      safetyPassed: false,
      recovery: null,
      taskCompleted: null,
    });
  });
  it("counts a revoke or pin control only when it was measured and passed", () => {
    const passed: MatrixResult = {
      id: "crash-03",
      experiment: "O9",
      tier: "T1",
      status: "passed",
      checks: { killedAtBoundary: true, noUnauthorizedEffect: true },
      measurements: { after: { autonomousCompletion: true } },
      coverage: [],
      gaps: [],
    };
    const crash03 = (results: MatrixResult[]) =>
      matrixEvidence(results).crashes.find((row) => row.id === "crash-03");
    const base = traced(passed, "run-base");
    const revoke = traced({ ...passed, id: "crash-03-revoke" }, "run-revoke");
    for (const pin of [
      { ...passed, id: "crash-03-pin", status: "incomplete" as const, checks: {} },
      traced(
        { ...passed, id: "crash-03-pin", status: "incomplete", checks: { killedAtBoundary: true } },
        "run-pin",
      ),
      traced({ ...passed, id: "crash-03-pin", checks: { killedAtBoundary: false } }, "run-pin"),
    ])
      expect(crash03([base, revoke, pin])).toEqual({
        id: "crash-03",
        status: "incomplete",
        missingReason: "missing-pin-control",
        recovery: null,
        safetyPassed: null,
        taskCompleted: null,
        traceIds: [],
      });
    expect(
      crash03([
        base,
        revoke,
        traced(
          {
            ...passed,
            id: "crash-03-pin",
            status: "finding",
            checks: { killedAtBoundary: true, noWrongPin: false },
          },
          "run-pin",
        ),
      ]),
    ).toMatchObject({ status: "incomplete", safetyPassed: false, recovery: null, traceIds: [] });
  });
  it("links a complete crash to the traces of every durable run it drove", async () => {
    const passed: MatrixResult = {
      id: "crash-03",
      experiment: "O9",
      tier: "T1",
      status: "passed",
      checks: { killedAtBoundary: true, noUnauthorizedEffect: true },
      measurements: { after: { autonomousCompletion: true } },
      coverage: [],
      gaps: [],
    };
    const results = [
      traced(passed, "run-base"),
      traced({ ...passed, id: "crash-03-revoke" }, "run-revoke"),
      traced({ ...passed, id: "crash-03-pin" }, "run-pin"),
    ];
    const evidence = matrixEvidence(results);
    const crash = evidence.crashes.find((row) => row.id === "crash-03")!;
    // Interrupted and recovering phases of one run share a single trace.
    expect(crash.traceIds).toHaveLength(3);
    expect(evidence.traces.map((trace) => trace.id).sort()).toEqual([...crash.traceIds].sort());
    expect(evidence.traces.every((trace) => trace.clock === "request-boundary")).toBe(true);
    expect(evidence.artifacts).toHaveLength(1);
    expect(
      evidence.traces.every((trace) => trace.artifactHash === evidence.artifacts[0]!.sha256),
    ).toBe(true);
    expect(contentDigest(evidence.rawTraces[0])).toBe(evidence.artifacts[0]!.sha256);
    const withoutPinTrace = [...results.slice(0, 2), { ...passed, id: "crash-03-pin" }];
    expect(
      matrixEvidence(withoutPinTrace).crashes.find((row) => row.id === "crash-03"),
    ).toMatchObject({ status: "incomplete", missingReason: "trace-links-missing", traceIds: [] });
    const directory = await mkdtemp(path.join(tmpdir(), "matrix-evidence-test-"));
    try {
      const written = await writeMatrixEvidence(directory, results);
      expect(written.map((file) => file.path.split("-")[0])).toEqual(["trace", "scoreboard"]);
      expect(written[0]!.sha256).toBe(evidence.artifacts[0]!.sha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("leaves a one-sided interrupt or recovery trace unlinked", () => {
    const terminal = (processId: string) =>
      phaseTrace(processId, "run-one-sided", ["terminal.committed"], LOCAL_TRACE_BOUNDARIES);
    const crash = (measurements: MatrixResult["measurements"]) =>
      matrixEvidence([crashAttempt("crash-04", measurements)]).crashes.find(
        (row) => row.id === "crash-04",
      );
    for (const row of [
      crash({
        before: { trace: terminal("interrupted-worker") },
        after: { autonomousCompletion: false },
      }),
      crash({
        after: { autonomousCompletion: false, trace: terminal("recovered-worker") },
      }),
    ])
      expect(row).toEqual({
        id: "crash-04",
        status: "incomplete",
        missingReason: "trace-links-missing",
        recovery: null,
        safetyPassed: null,
        taskCompleted: null,
        traceIds: [],
      });
  });
  it.each([
    [
      "admission points only",
      ["admission.started", "admission.committed"],
      ["admission.committed"],
      undefined,
    ],
    [
      "two terminal points",
      ["terminal.committed"],
      ["admission.started", "terminal.committed"],
      undefined,
    ],
    [
      "a buffer that dropped the terminal point",
      ["admission.started", "terminal.committed"],
      ["admission.committed"],
      1,
    ],
  ] as const)("leaves a pair with %s unlinked", (_label, before, after, capacity) => {
    const crash = matrixEvidence([
      crashAttempt("crash-04", {
        before: {
          trace: phaseTrace(
            "interrupted-worker",
            "run-pair",
            before,
            LOCAL_TRACE_BOUNDARIES,
            capacity ? { capacity } : {},
          ),
        },
        after: {
          autonomousCompletion: false,
          trace: phaseTrace("recovered-worker", "run-pair", after, LOCAL_TRACE_BOUNDARIES),
        },
      }),
    ]).crashes.find((row) => row.id === "crash-04");
    expect(crash).toEqual({
      id: "crash-04",
      status: "incomplete",
      missingReason: "trace-links-missing",
      recovery: null,
      safetyPassed: null,
      taskCompleted: null,
      traceIds: [],
    });
  });
  it("accepts a collector-complete pair under the stored boundaries", () => {
    const stored = LOCAL_TRACE_BOUNDARIES;
    const crash = matrixEvidence([
      crashAttempt("crash-04", {
        before: {
          trace: phaseTrace(
            "interrupted-worker",
            "run-pair",
            stored.filter((boundary) => boundary !== "terminal.committed"),
            stored,
          ),
        },
        after: {
          autonomousCompletion: false,
          trace: phaseTrace("recovered-worker", "run-pair", ["terminal.committed"], stored),
        },
      }),
    ]).crashes.find((row) => row.id === "crash-04");
    expect(crash).toMatchObject({
      status: "complete",
      missingReason: null,
      recovery: "explicit-uncertainty",
      safetyPassed: true,
      taskCompleted: false,
    });
    expect(crash?.traceIds).toHaveLength(1);
  });
  it("retains every canonical experiment, variant and owner without marking declarations passed", () => {
    const coverage = experimentCoverage();
    expect(coverage.map((row) => row.id)).toEqual(
      Array.from({ length: 13 }, (_, i) => `O${i + 1}`),
    );
    for (const row of coverage) {
      expect(row.owners.length).toBeGreaterThan(0);
      expect(row.variants).toEqual(
        EXPERIMENT_DEFINITIONS.find((item) => item.id === row.id)?.variants,
      );
      expect(row.status).not.toBe("passed");
    }
    expect(coverage.find((row) => row.id === "O13")?.status).toBe("feature-not-implemented");
  });
  it("keeps all ten fault expectations and expands the declared cross products", () => {
    const smoke = matrixPlan("smoke");
    const release = matrixPlan("release");
    expect(smoke.faults).toEqual(CRASH_BOUNDARIES);
    expect(smoke.requiredComparisonPairs).toBe(1);
    expect(matrixPlan("commit").requiredComparisonPairs).toBe(20);
    expect(release.requiredComparisonPairs).toBe(200);
    expect(release.memory).toHaveLength(6);
    expect(release.load).toHaveLength(6);
    expect(release.connectors).toEqual([0, 10, 50]);
    expect(release.releaseEligible).toBe(false);
    expect(() => matrixPlan("unknown" as never)).toThrow();
  });
  it("cannot turn absent observations, missing release coverage or a failed safety check into pass", () => {
    const result = {
      id: "fixture",
      experiment: "O9",
      tier: "T1" as const,
      status: "passed" as const,
      checks: { safety: true },
      measurements: {},
      coverage: [],
      gaps: [],
    };
    expect(matrixExitCode([], false)).toBe(2);
    expect(matrixExitCode([result], false)).toBe(0);
    expect(matrixExitCode([result], true)).toBe(2);
    expect(matrixExitCode([{ ...result, checks: { safety: false } }], false)).toBe(1);
    expect(matrixExitCode([{ ...result, status: "incomplete" }], false)).toBe(2);
    const unobserved = classifyMemoryScale([], true, true);
    expect(unobserved.status).toBe("incomplete");
    expect(Object.values(unobserved.checks)).toContain(false);
    expect(
      matrixExitCode(
        [{ ...result, id: "O5-unread", status: unobserved.status, checks: unobserved.checks }],
        false,
      ),
    ).toBe(2);
    const materialized = classifyMemoryScale([{ documents: 100, revisions: 2000 }], true, true);
    expect(materialized.status).toBe("finding");
    expect(
      matrixExitCode(
        [
          {
            ...result,
            id: "O5-scale",
            status: materialized.status,
            checks: materialized.checks,
          },
        ],
        false,
      ),
    ).toBe(1);
  });
  it("writes checksummed immutable evidence and refuses replacing an attempt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "matrix-evidence-test-"));
    try {
      const payload = { measuredZero: 0, unknown: null, samples: [12, 400, 15] };
      const artifact = await writeMatrixArtifact(directory, "result", payload);
      const saved = JSON.parse(await readFile(path.join(directory, artifact.path), "utf8"));
      expect(contentDigest(saved.payload)).toBe(artifact.sha256);
      expect(saved.payload.samples).toEqual([12, 400, 15]);
      await expect(writeMatrixArtifact(directory, "result", payload)).rejects.toMatchObject({
        code: "EEXIST",
      });
      await expect(writeMatrixArtifact(directory, "../escape", payload)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
