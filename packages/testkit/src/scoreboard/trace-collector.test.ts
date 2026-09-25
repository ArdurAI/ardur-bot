import type { TracePoint } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { createTraceBuffer } from "../../../adapters/src/scoreboard-trace.js";
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
});
