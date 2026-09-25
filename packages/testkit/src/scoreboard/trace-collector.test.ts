import type { TraceBatch, TracePoint } from "@ardurbot/contracts";
import { nextFence } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import { createTraceBuffer } from "../../../adapters/src/scoreboard-trace.js";
import type { MatrixResult } from "./experiments/catalog.js";
import { matrixEvidence } from "./experiments/evidence.js";
import {
  calibrateTraceClock,
  collectTraceEvidence,
  deriveTrace,
  traceDuration,
} from "./trace-collector.js";

const point = (
  boundary: TracePoint["boundary"],
  at: number,
  sequence: number,
  extra: Partial<TracePoint> = {},
): TracePoint => ({ traceId: "run-a", processId: "worker", boundary, at, sequence, ...extra });

describe("trace evidence", () => {
  it("does not subtract clocks from different processes, even when the numbers look plausible", () => {
    const a = point("text.safe", 100, 0);
    const b = point("client.text.painted", 110, 0, { processId: "browser" });
    expect(traceDuration(a, b).value).toBeNull();
    expect(traceDuration(a, { ...a, at: Number.NaN }).value).toBeNull();
    const calibration = calibrateTraceClock({
      processId: "browser",
      referenceProcessId: "worker",
      referenceSent: 5,
      remoteReceived: 1000,
      remoteSent: 1002,
      referenceReceived: 9,
      validForMs: 100,
      maxDriftMs: 0.1,
    });
    const result = traceDuration(point("text.safe", 10, 0), { ...b, at: 1010 }, [calibration]);
    expect(result.lowerMs).toBeCloseTo(4.9);
    expect(result.upperMs).toBeCloseTo(7.1);
    expect(traceDuration(a, { ...b, at: 2000 }, [calibration]).reason).toBe("clock-not-calibrated");
  });

  it("unions overlapping work per trace before deriving the residual", () => {
    const points = [
      point("admission.started", 0, 0),
      point("provider.started", 10, 1, { operationId: "a" }),
      point("tool.started", 20, 2, { operationId: "tool" }),
      point("tool.finished", 40, 3, { operationId: "tool", outcome: "success" }),
      point("provider.finished", 60, 4, { operationId: "a", outcome: "success" }),
      point("terminal.committed", 100, 5, { outcome: "failed" }),
    ];
    const result = deriveTrace(points);
    expect(result.service.value).toBe(50);
    expect(result.residual.value).toBe(50);
    expect(result.outcome).toBe("failed");
    expect(result.metrics["m01.user-ttft"]!.value).toBeNull();
    expect(
      deriveTrace(points.filter((p) => p.boundary !== "tool.finished")).residual.value,
    ).toBeNull();
  });

  it("separates schedule and capacity while keeping them in total elapsed time", () => {
    const result = deriveTrace([
      point("admission.started", 0, 0),
      point("job.submitted", 10, 1, { scheduledMs: 100 }),
      point("job.enqueued", 11, 5),
      point("wait.capacity", 120, 2),
      point("lease.acquired", 150, 3),
      point("terminal.committed", 200, 4, { outcome: "success" }),
    ]);
    expect(result.metrics["m08.eligible-to-lease"]!.value).toBe(40);
    expect(result.metrics["m08.schedule-delay"]!.value).toBe(100);
    expect(result.waits[0]!.duration.value).toBe(30);
    expect(result.admissionToTerminal.value).toBe(200);
  });

  it("retains a fast queue interval when the worker leases before publication acknowledges", () => {
    const result = deriveTrace([
      point("job.submitted", 10, 0),
      point("lease.acquired", 11, 1),
      point("job.enqueued", 12, 2),
    ]);
    expect(result.metrics["m08.eligible-to-lease"]).toEqual({
      value: 0.5,
      lowerMs: 0,
      upperMs: 1,
      reason: null,
    });
  });

  it("bounds a fast cross-process queue using calibrated clocks, never independent sequences", () => {
    const result = deriveTrace(
      [
        point("job.submitted", 10, 900),
        point("job.enqueued", 12, 901),
        point("lease.acquired", 111, 0, { processId: "consumer" }),
      ],
      [
        {
          processId: "consumer",
          referenceProcessId: "worker",
          offsetLowerMs: -100,
          offsetUpperMs: -100,
          validFrom: 0,
          validUntil: 200,
        },
      ],
    );
    expect(result.metrics["m08.eligible-to-lease"]).toMatchObject({ lowerMs: 0, upperMs: 1 });
    expect(
      deriveTrace([
        point("job.submitted", 10, 0),
        point("job.enqueued", 12, 1),
        point("lease.acquired", 111, 0, { processId: "consumer" }),
      ]).metrics["m08.eligible-to-lease"]!.value,
    ).toBeNull();
  });

  it("closes quota waits only at the matching logical request retry", () => {
    const wait = point("wait.quota", 10, 1, {
      requestId: "request-a",
      operationId: "a-0",
      attempt: 1,
    });
    const helper = point("provider.started", 20, 2, {
      requestId: "request-b",
      operationId: "b-0",
      attempt: 1,
    });
    const retry = point("provider.started", 1000, 3, {
      requestId: "request-a",
      operationId: "a-1",
      attempt: 1,
    });
    expect(deriveTrace([wait, helper, retry]).waits[0]!.duration.value).toBe(990);
    expect(deriveTrace([wait, helper]).waits[0]!.duration.value).toBeNull();
    expect(deriveTrace([wait, { ...retry, attempt: 2 }]).waits[0]!.duration.value).toBeNull();
    expect(
      deriveTrace([{ ...wait, requestId: undefined }, retry]).waits[0]!.duration.value,
    ).toBeNull();
  });

  it("measures a cross-process crash span from wall time, never the process-local clocks", () => {
    const attempt = 7;
    const killedOrigin = 1_700_000_000_000;
    const recoveredOrigin = 1_700_000_005_000;
    const startedAt = 4000;
    const finishedAt = 10;
    const wall = recoveredOrigin + finishedAt - (killedOrigin + startedAt);
    const spanOf = (
      killedOriginValue: number | undefined,
      recoveredOriginValue: number | undefined,
      endAt: number,
    ) => {
      const killed = createTraceBuffer({ processId: "interrupted-worker", now: () => 1 });
      const recovered = createTraceBuffer({ processId: "recovered-worker", now: () => 1 });
      killed.record("run-a", "admission.started", {}, 0);
      killed.record("run-a", "tool.started", { operationId: "tool-1", attempt }, startedAt);
      recovered.record(
        "run-a",
        "tool.finished",
        { operationId: "tool-1", attempt: nextFence(attempt), outcome: "success" },
        endAt,
      );
      recovered.record("run-a", "terminal.committed", { outcome: "success" }, endAt + 1);
      const stamp = (batch: TraceBatch, timeOrigin: number | undefined) => {
        if (timeOrigin === undefined) delete (batch as { timeOrigin?: number }).timeOrigin;
        else (batch as { timeOrigin?: number }).timeOrigin = timeOrigin;
        // This case locks the documented widening used when a batch omits clock uncertainty.
        delete (batch as { clockUncertaintyMs?: number }).clockUncertaintyMs;
        return batch;
      };
      const evidence = collectTraceEvidence(
        [
          stamp(killed.snapshot(), killedOriginValue),
          stamp(recovered.snapshot(), recoveredOriginValue),
        ],
        {
          sessionId: "crash",
          pairId: null,
          requiredBoundaries: [
            "admission.started",
            "tool.started",
            "tool.finished",
            "terminal.committed",
          ],
          pairAcrossProcesses: true,
        },
      );
      const span = evidence.derived[0]!.operations.find(
        (operation) => operation.kind === "tool.started",
      )!.duration;
      return { span, complete: evidence.derived[0]!.complete };
    };
    const forward = spanOf(killedOrigin, recoveredOrigin, finishedAt);
    expect(forward.complete).toBe(true);
    expect(forward.span).toEqual({
      value: wall,
      lowerMs: wall - 1000,
      upperMs: wall + 1000,
      reason: "wall-clock",
    });
    expect(forward.span.reason).not.toBe("reversed-boundaries");
    expect(forward.span.value).not.toBe(finishedAt - startedAt);
    const uncalibrated = spanOf(undefined, recoveredOrigin, 5000);
    expect(uncalibrated.complete).toBe(false);
    expect(uncalibrated.span).toEqual({
      value: null,
      lowerMs: null,
      upperMs: null,
      reason: "clock-not-calibrated",
    });
    expect(uncalibrated.span.reason).not.toBe("reversed-boundaries");
    expect(uncalibrated.span.value).not.toBe(5000 - startedAt);
    const skewed = spanOf(recoveredOrigin, killedOrigin, 5000);
    expect(skewed.complete).toBe(false);
    expect(skewed.span).toEqual({
      value: null,
      lowerMs: null,
      upperMs: null,
      reason: "clock-skew",
    });
    expect(skewed.span.reason).not.toBe("reversed-boundaries");
    expect(skewed.span.value).not.toBe(5000 - startedAt);
    const same = createTraceBuffer({ processId: "only-worker", now: () => 1 });
    same.record("run-a", "tool.started", { operationId: "tool-1", attempt }, 10);
    same.record(
      "run-a",
      "tool.finished",
      { operationId: "tool-1", attempt, outcome: "success" },
      40,
    );
    const alone = deriveTrace(same.snapshot().points);
    expect(alone.operations[0]!.duration).toEqual({
      value: 30,
      lowerMs: 30,
      upperMs: 30,
      reason: null,
    });
  });

  it("pairs a killed start with the recovering process's next lease fence", () => {
    const attempt = 7;
    const killedOrigin = 1_700_000_000_000;
    const recoveredOrigin = 1_700_000_002_500;
    const evidenceFor = (finishAttempt: number) => {
      const killed = createTraceBuffer({ processId: "interrupted-worker", now: () => 1 });
      const recovered = createTraceBuffer({ processId: "recovered-worker", now: () => 1 });
      killed.record("run-a", "admission.started", {}, 0);
      killed.record("run-a", "tool.started", { operationId: "tool-1", attempt }, 20);
      recovered.record(
        "run-a",
        "tool.finished",
        { operationId: "tool-1", attempt: finishAttempt, outcome: "success" },
        35,
      );
      recovered.record("run-a", "terminal.committed", { outcome: "success" }, 40);
      const killedBatch = killed.snapshot();
      const recoveredBatch = recovered.snapshot();
      (killedBatch as { timeOrigin?: number }).timeOrigin = killedOrigin;
      (recoveredBatch as { timeOrigin?: number }).timeOrigin = recoveredOrigin;
      return collectTraceEvidence([killedBatch, recoveredBatch], {
        sessionId: "crash",
        pairId: null,
        requiredBoundaries: [
          "admission.started",
          "tool.started",
          "tool.finished",
          "terminal.committed",
        ],
        pairAcrossProcesses: true,
      });
    };
    const paired = evidenceFor(nextFence(attempt));
    expect(paired.derived[0]!.complete).toBe(true);
    expect(paired.derived[0]!.operations[0]).toMatchObject({
      outcome: "success",
      duration: {
        value: recoveredOrigin + 35 - (killedOrigin + 20),
        reason: "wall-clock",
      },
    });
    const unrelated = evidenceFor(nextFence(nextFence(attempt)) + 5);
    expect(unrelated.derived[0]!.operations[0]).toMatchObject({
      outcome: "interrupted",
      duration: { value: null, reason: "interrupted" },
    });
    expect(unrelated.derived[0]!.complete).toBe(false);
  });

  it("pairs crash boundaries across processes only when crash evidence asks", () => {
    const before = createTraceBuffer({
      processId: "interrupted-worker",
      now: () => 1,
      clockUncertaintyMs: 0,
    });
    const after = createTraceBuffer({
      processId: "recovered-worker",
      now: () => 1,
      clockUncertaintyMs: 0,
    });
    before.record("run-a", "admission.started", {}, 0);
    before.record("run-a", "provider.started", { operationId: "provider-1", attempt: 0 }, 10);
    before.record("run-a", "tool.started", { operationId: "tool-1", attempt: 0 }, 20);
    before.record("run-a", "tool.started", { operationId: "tool-cut", attempt: 0 }, 25);
    after.record(
      "run-a",
      "provider.finished",
      { operationId: "provider-1", attempt: nextFence(0), outcome: "success" },
      40,
    );
    after.record(
      "run-a",
      "tool.finished",
      { operationId: "tool-1", attempt: nextFence(0), outcome: "success" },
      50,
    );
    after.record("run-a", "terminal.committed", { outcome: "success" }, 60);
    const requiredBoundaries = [
      "admission.started",
      "provider.started",
      "provider.finished",
      "tool.started",
      "tool.finished",
      "terminal.committed",
    ] as const;
    const options = { sessionId: "crash", pairId: null, requiredBoundaries };
    const batches = [before.snapshot(), after.snapshot()];
    const paired = collectTraceEvidence(batches, { ...options, pairAcrossProcesses: true });
    expect(paired.derived[0]!.complete).toBe(false);
    expect(
      paired.derived[0]!.operations.find((operation) => operation.kind === "tool.started")!.duration
        .value,
    ).toBe(30);
    expect(
      paired.derived[0]!.operations.find((operation) => operation.outcome === "interrupted"),
    ).toMatchObject({ kind: "tool.started", duration: { reason: "interrupted" } });
    const ordinary = collectTraceEvidence(batches, options);
    expect(ordinary.derived[0]!.complete).toBe(false);
    expect(ordinary.derived[0]!.operations[0]!.duration.reason).toBe("boundary-not-observed");
    const single = createTraceBuffer({ processId: "only-worker", now: () => 1 });
    single.record("run-a", "admission.started", {}, 0);
    single.record("run-a", "provider.started", { operationId: "provider-1", attempt: 0 }, 10);
    single.record("run-a", "tool.started", { operationId: "tool-1", attempt: 0 }, 20);
    single.record("run-a", "terminal.committed", { outcome: "success" }, 30);
    const alone = collectTraceEvidence([single.snapshot()], {
      ...options,
      requiredBoundaries: [
        "admission.started",
        "provider.started",
        "tool.started",
        "terminal.committed",
      ],
    });
    expect(alone.derived[0]!.missingBoundaries).toEqual([]);
    expect(alone.derived[0]!.complete).toBe(false);
  });

  it("does not pair service boundaries from independently numbered processes", () => {
    const result = deriveTrace([
      point("admission.started", 0, 500),
      point("provider.started", 1, 501, { operationId: "request-a" }),
      point("provider.finished", 2, 999, { operationId: "request-a", processId: "other-worker" }),
      point("terminal.committed", 3, 502, { outcome: "success" }),
    ]);
    expect(result.operations[0]!.duration.value).toBeNull();
    expect(result.service.value).toBeNull();
    expect(result.admissionToTerminal.value).toBe(3);
  });

  it("keeps approval and quota waits separate and unfinished approval unknown", () => {
    const points = [
      point("admission.started", 0, 0),
      point("wait.quota", 10, 1, { requestId: "request", operationId: "request-1" }),
      point("provider.started", 30, 2, { requestId: "request", operationId: "request-2" }),
      point("wait.approval", 40, 3),
      point("lease.acquired", 100, 4),
      point("wait.approval", 110, 5),
      point("terminal.committed", 120, 6, { outcome: "cancelled" }),
    ];
    const result = deriveTrace(points);
    expect(result.waits.map((w) => [w.kind, w.duration.value])).toEqual([
      ["wait.quota", 20],
      ["wait.approval", 60],
      ["wait.approval", null],
    ]);
    expect(result.admissionToTerminal.value).toBe(120);
    expect(result.outcome).toBe("cancelled");
  });

  it("retains failed attempts, refuses ambiguous terminal outcomes and reports trace loss", () => {
    const buffer = createTraceBuffer({ capacity: 4, processId: "worker", now: () => 1 });
    buffer.record("run-a", "admission.started");
    buffer.record("run-a", "provider.started", { operationId: "retry-0" });
    buffer.record("run-a", "provider.finished", { operationId: "retry-0", outcome: "failed" });
    buffer.record("run-a", "terminal.committed", { outcome: "failed" });
    buffer.record("run-a", "text.safe");
    const evidence = collectTraceEvidence([buffer.snapshot()], {
      sessionId: "session-a",
      pairId: "pair-a",
      requiredBoundaries: ["admission.started", "terminal.committed"],
      virtual: true,
    });
    expect(evidence.derived[0]!.complete).toBe(false);
    expect(evidence.derived[0]!.operations[0]!.outcome).toBe("failed");
    expect(evidence.metrics.every((m) => m.observations[0]!.value === null)).toBe(true);
    expect(JSON.stringify(evidence.raw)).not.toContain("run-a");
    const terminal = point("terminal.committed", 100, 1, { outcome: "success" });
    const ambiguous = deriveTrace([
      point("admission.started", 0, 0),
      point("client.submitted", 0, 3),
      terminal,
      { ...terminal, sequence: 2, outcome: "failed" },
    ]);
    expect(ambiguous.terminalConsistent).toBe(false);
    expect(ambiguous.admissionToTerminal.value).toBeNull();
    expect(ambiguous.metrics["m03.durable-terminal"]!.value).toBeNull();
  });

  it("retains unknown coverage for missing submissions and rejects ambiguous pairing", () => {
    const batch = createTraceBuffer({ now: () => 1 });
    batch.record("run-a", "job.submitted");
    const options = { sessionId: "session-a", pairId: null, requiredBoundaries: [] };
    const evidence = collectTraceEvidence([batch.snapshot()], { ...options, expectedTraces: 2 });
    expect(evidence.coverage).toMatchObject({ expected: 2, observed: 1 });
    expect(evidence.metrics.find((m) => m.id === "m08.schedule-delay")).toMatchObject({
      missingReason: "unknown",
      coverage: { expected: 2, observed: 1 },
    });
    batch.record("run-b", "job.submitted");
    expect(() =>
      collectTraceEvidence([batch.snapshot()], { ...options, pairId: "one-pair" }),
    ).toThrow("one paired trace");
  });

  it("rejects a body smuggled into raw trace artifacts", () => {
    const batch = createTraceBuffer({ now: () => 0 }).snapshot();
    batch.points.push({
      ...point("admission.started", 0, 0, { processId: batch.processId }),
      prompt: "synthetic private text",
    } as TracePoint);
    expect(() =>
      collectTraceEvidence([batch], {
        sessionId: "session-a",
        pairId: null,
        requiredBoundaries: [],
      }),
    ).toThrow("unsanitized");
  });

  it("exports a hashed logical request identity and rejects content in that field", () => {
    const buffer = createTraceBuffer({ now: () => 1 });
    buffer.record("run-a", "provider.started", {
      requestId: "private-request",
      operationId: "attempt-1",
    });
    const options = { sessionId: "session-a", pairId: null, requiredBoundaries: [] };
    const evidence = collectTraceEvidence([buffer.snapshot()], options);
    expect(evidence.raw.batches[0]!.points[0]!.requestId).toMatch(/^trace-[a-f0-9]{32}$/);
    expect(JSON.stringify(evidence.raw)).not.toContain("private-request");
    const invalid = buffer.snapshot();
    invalid.points[0]!.requestId = "request with private body";
    expect(() => collectTraceEvidence([invalid], options)).toThrow("unsanitized");
    buffer.record("run-a", "provider.started", { requestId: "request with private body" });
    expect(buffer.snapshot().counters.invalid).toBe(1);
  });

  it("reports cross-process spans as wall-clock intervals and leaves an unmeasured crash incomplete", () => {
    const attempt = 4;
    const killedOrigin = 1_700_000_000_000;
    const recoveredOrigin = 1_700_000_003_000;
    const startedAt = 20;
    const finishedAt = 35;
    const wall = recoveredOrigin + finishedAt - (killedOrigin + startedAt);
    const spanOf = (
      origins: { killed?: number; recovered?: number },
      uncertainty?: { killed?: number; recovered?: number },
      endAt = finishedAt,
    ) => {
      const killed = createTraceBuffer({
        processId: "interrupted-worker",
        now: () => 1,
        timeOrigin: origins.killed,
        clockUncertaintyMs: uncertainty?.killed,
      });
      const recovered = createTraceBuffer({
        processId: "recovered-worker",
        now: () => 1,
        timeOrigin: origins.recovered,
        clockUncertaintyMs: uncertainty?.recovered,
      });
      killed.record("run-a", "admission.started", {}, 0);
      killed.record("run-a", "tool.started", { operationId: "tool-1", attempt }, startedAt);
      recovered.record(
        "run-a",
        "tool.finished",
        { operationId: "tool-1", attempt: nextFence(attempt), outcome: "success" },
        endAt,
      );
      recovered.record("run-a", "terminal.committed", { outcome: "success" }, endAt + 1);
      const batches = [killed.snapshot(), recovered.snapshot()];
      if (origins.killed === undefined) delete batches[0]!.timeOrigin;
      if (origins.recovered === undefined) delete batches[1]!.timeOrigin;
      if (!uncertainty) {
        delete batches[0]!.clockUncertaintyMs;
        delete batches[1]!.clockUncertaintyMs;
      }
      const evidence = collectTraceEvidence(batches, {
        sessionId: "crash",
        pairId: null,
        requiredBoundaries: [
          "admission.started",
          "tool.started",
          "tool.finished",
          "terminal.committed",
        ],
        pairAcrossProcesses: true,
      });
      return evidence.derived[0]!.operations[0]!.duration;
    };
    const forward = spanOf({ killed: killedOrigin, recovered: recoveredOrigin });
    expect(forward.reason).toBe("wall-clock");
    expect(forward.value).toBe(wall);
    expect(forward.lowerMs).toBe(wall - 1000);
    expect(forward.upperMs).toBe(wall + 1000);
    const widened = spanOf(
      { killed: killedOrigin, recovered: recoveredOrigin },
      { killed: 40, recovered: 60 },
    );
    expect(widened).toEqual({
      value: wall,
      lowerMs: wall - 100,
      upperMs: wall + 100,
      reason: "wall-clock",
    });
    const crash = (
      origins: { killed?: number; recovered?: number },
      endAt: number,
    ): MatrixResult => {
      const killed = createTraceBuffer({ processId: "interrupted-worker", now: () => 1 });
      const recovered = createTraceBuffer({ processId: "recovered-worker", now: () => 1 });
      killed.record("run-a", "admission.started", {}, 0);
      killed.record("run-a", "tool.started", { operationId: "tool-1", attempt }, startedAt);
      recovered.record(
        "run-a",
        "tool.finished",
        { operationId: "tool-1", attempt: nextFence(attempt), outcome: "success" },
        endAt,
      );
      recovered.record("run-a", "terminal.committed", { outcome: "success" }, endAt + 1);
      const before = killed.snapshot();
      const after = recovered.snapshot();
      if (origins.killed === undefined) delete before.timeOrigin;
      else before.timeOrigin = origins.killed;
      if (origins.recovered === undefined) delete after.timeOrigin;
      else after.timeOrigin = origins.recovered;
      const stored = ["admission.started", "tool.started", "tool.finished", "terminal.committed"];
      const phase = (batch: TraceBatch) => ({
        ...collectTraceEvidence([batch], {
          sessionId: "matrix-fault",
          pairId: null,
          requiredBoundaries: stored,
        }),
        requiredBoundaries: stored,
      });
      return {
        id: "crash-04",
        experiment: "O9",
        tier: "T1",
        status: "passed",
        checks: { killedAtBoundary: true },
        measurements: {
          before: { trace: phase(before) },
          after: { autonomousCompletion: false, trace: phase(after) },
        },
        coverage: [],
        gaps: [],
      };
    };
    expect(
      matrixEvidence([crash({ killed: undefined, recovered: recoveredOrigin }, 40)]).crashes[3],
    ).toMatchObject({
      status: "incomplete",
      missingReason: "crash-span-unmeasured",
      safetyPassed: null,
      recovery: null,
    });
    expect(
      matrixEvidence([crash({ killed: recoveredOrigin, recovered: killedOrigin }, 10)]).crashes[3],
    ).toMatchObject({
      status: "incomplete",
      missingReason: "crash-span-unmeasured",
      safetyPassed: null,
      recovery: null,
    });
    expect(spanOf({ killed: undefined, recovered: recoveredOrigin }).reason).toBe(
      "clock-not-calibrated",
    );
    expect(spanOf({ killed: recoveredOrigin, recovered: killedOrigin }, undefined, 10).reason).toBe(
      "clock-skew",
    );
  });

  it("leaves a finish on any fence other than the next one unmeasured", () => {
    const attempt = 4;
    const crash = (finishAttempt: number) =>
      matrixEvidence([
        fenceCrash(attempt, finishAttempt, {
          killed: 1_700_000_000_000,
          recovered: 1_700_000_003_000,
        }),
      ]).crashes.find((row) => row.id === "crash-04");
    expect(crash(attempt + 2)).toMatchObject({
      status: "incomplete",
      missingReason: "crash-span-unmeasured",
      safetyPassed: null,
      recovery: null,
    });
  });

  it("accepts a finish on the next fence when the span stays measured", () => {
    const attempt = 4;
    const crash = matrixEvidence([
      fenceCrash(attempt, nextFence(attempt), {
        killed: 1_700_000_000_000,
        recovered: 1_700_000_003_000,
      }),
    ]).crashes.find((row) => row.id === "crash-04");
    expect(crash).toMatchObject({ status: "complete", missingReason: null });
  });

  it("rejects a wall span whose uncertainty interval crosses zero", () => {
    const attempt = 4;
    const uncertain = matrixEvidence([
      fenceCrash(
        attempt,
        nextFence(attempt),
        { killed: 1_700_000_000_000, recovered: 1_700_000_000_400 },
        { killed: 500, recovered: 500 },
        20,
      ),
    ]).crashes.find((row) => row.id === "crash-04");
    expect(uncertain).toMatchObject({
      status: "incomplete",
      missingReason: "crash-span-unmeasured",
      safetyPassed: null,
      recovery: null,
    });
  });

  it("keeps a cross-process span whose interval stays above zero", () => {
    const attempt = 4;
    const measured = matrixEvidence([
      fenceCrash(
        attempt,
        nextFence(attempt),
        { killed: 1_700_000_000_000, recovered: 1_700_000_000_400 },
        { killed: 50, recovered: 50 },
        20,
      ),
    ]).crashes.find((row) => row.id === "crash-04");
    expect(measured).toMatchObject({ status: "complete", missingReason: null });
    const killed = createTraceBuffer({
      processId: "interrupted-worker",
      now: () => 1,
      timeOrigin: 1_700_000_000_000,
      clockUncertaintyMs: 50,
    });
    const recovered = createTraceBuffer({
      processId: "recovered-worker",
      now: () => 1,
      timeOrigin: 1_700_000_000_400,
      clockUncertaintyMs: 50,
    });
    killed.record("run-a", "tool.started", { operationId: "tool-1", attempt }, 0);
    recovered.record(
      "run-a",
      "tool.finished",
      { operationId: "tool-1", attempt: nextFence(attempt), outcome: "success" },
      0,
    );
    const span = collectTraceEvidence([killed.snapshot(), recovered.snapshot()], {
      sessionId: "crash",
      pairId: null,
      requiredBoundaries: ["tool.started", "tool.finished"],
      pairAcrossProcesses: true,
    }).derived[0]!.operations[0]!.duration;
    expect(span).toEqual({ value: 400, lowerMs: 300, upperMs: 500, reason: "wall-clock" });
  });

  it("records clock uncertainty on every trace batch", () => {
    const buffer = createTraceBuffer({ processId: "worker-a", now: () => 1 });
    const first = buffer.snapshot();
    const second = buffer.drain();
    expect(first.clockUncertaintyMs).toEqual(expect.any(Number));
    expect(first.clockUncertaintyMs).toBeGreaterThanOrEqual(0);
    expect(second.clockUncertaintyMs).toBe(first.clockUncertaintyMs);
    const explicit = createTraceBuffer({
      processId: "worker-b",
      now: () => 1,
      clockUncertaintyMs: 1000,
    });
    expect(explicit.snapshot().clockUncertaintyMs).toBe(1000);
  });
});

function fenceCrash(
  attempt: number,
  finishAttempt: number,
  origins: { killed: number; recovered: number },
  uncertainty?: { killed: number; recovered: number },
  finishedAt = 35,
): MatrixResult {
  const stored = ["admission.started", "tool.started", "tool.finished", "terminal.committed"];
  const killed = createTraceBuffer({
    processId: "interrupted-worker",
    now: () => 1,
    timeOrigin: origins.killed,
    clockUncertaintyMs: uncertainty?.killed,
  });
  const recovered = createTraceBuffer({
    processId: "recovered-worker",
    now: () => 1,
    timeOrigin: origins.recovered,
    clockUncertaintyMs: uncertainty?.recovered,
  });
  killed.record("run-a", "admission.started", {}, 0);
  killed.record("run-a", "tool.started", { operationId: "tool-1", attempt }, 20);
  recovered.record(
    "run-a",
    "tool.finished",
    { operationId: "tool-1", attempt: finishAttempt, outcome: "success" },
    finishedAt,
  );
  recovered.record("run-a", "terminal.committed", { outcome: "success" }, finishedAt + 1);
  const phase = (batch: TraceBatch) => ({
    ...collectTraceEvidence([batch], {
      sessionId: "matrix-fault",
      pairId: null,
      requiredBoundaries: stored,
    }),
    requiredBoundaries: stored,
  });
  return {
    id: "crash-04",
    experiment: "O9",
    tier: "T1",
    status: "passed",
    checks: { killedAtBoundary: true },
    measurements: {
      before: { trace: phase(killed.snapshot()) },
      after: { autonomousCompletion: false, trace: phase(recovered.snapshot()) },
    },
    coverage: [],
    gaps: [],
  };
}
