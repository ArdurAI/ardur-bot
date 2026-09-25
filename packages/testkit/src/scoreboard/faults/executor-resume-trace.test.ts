import { nextFence } from "@ardurbot/core";
import { afterEach, expect, it } from "vitest";
import { beginRecordedTool, finishRecordedTool } from "../../../../adapters/src/executor.js";
import { startScoreboardTrace } from "../../../../adapters/src/scoreboard-trace.js";
import { collectTraceEvidence } from "../trace-collector.js";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

const RUN = "run-resume";
const ORIGINAL = `${RUN}:destination.write:0`;
const MINTED = `${RUN}:destination.write:1`;
const DIGEST = "a".repeat(64);

function capture(processId: string, timeOrigin: number, record: () => void) {
  const trace = startScoreboardTrace({ processId, timeOrigin, now: () => 1 });
  stop = trace.stop;
  try {
    record();
    return trace.snapshot();
  } finally {
    trace.stop();
    stop = undefined;
  }
}

it("records a resumed tool finish with the original id and the next fence", () => {
  const attempt = 2;
  const killed = capture("interrupted-worker", 1_700_000_000_000, () => {
    traceStart(attempt);
  });
  const recovered = capture("recovered-worker", 1_700_000_002_000, () => {
    const claim = beginRecordedTool({
      runId: RUN,
      fence: nextFence(attempt),
      name: "destination.write",
      executionId: MINTED,
      argumentDigest: DIGEST,
      unfinished: [{ name: "destination.write", executionId: ORIGINAL, argumentDigest: DIGEST }],
    });
    finishRecordedTool({
      runId: RUN,
      fence: nextFence(attempt),
      operationId: claim.operationId,
      outcome: "success",
    });
    expect(claim).toEqual({ operationId: ORIGINAL, resumed: true });
  });
  const finish = recovered.points.find((point) => point.boundary === "tool.finished");
  expect(finish).toMatchObject({
    operationId: ORIGINAL,
    attempt: nextFence(attempt),
  });
  expect(recovered.points.some((point) => point.boundary === "tool.started")).toBe(false);
  const paired = collectTraceEvidence([killed, recovered], {
    sessionId: "crash",
    pairId: null,
    requiredBoundaries: ["tool.started", "tool.finished"],
    pairAcrossProcesses: true,
  });
  expect(paired.derived[0]!.operations[0]).toMatchObject({
    outcome: "success",
    duration: { reason: "wall-clock" },
  });
});

it("leaves a finish recorded under a new id interrupted", () => {
  const attempt = 2;
  const killed = capture("interrupted-worker", 1_700_000_000_000, () => {
    traceStart(attempt);
  });
  const recovered = capture("recovered-worker", 1_700_000_002_000, () => {
    const claim = beginRecordedTool({
      runId: RUN,
      fence: nextFence(attempt),
      name: "destination.write",
      executionId: MINTED,
      argumentDigest: DIGEST,
      unfinished: [],
    });
    finishRecordedTool({
      runId: RUN,
      fence: nextFence(attempt),
      operationId: claim.operationId,
      outcome: "success",
    });
  });
  const paired = collectTraceEvidence([killed, recovered], {
    sessionId: "crash",
    pairId: null,
    requiredBoundaries: ["tool.started", "tool.finished"],
    pairAcrossProcesses: true,
  });
  expect(paired.derived[0]!.operations[0]).toMatchObject({
    outcome: "interrupted",
    duration: { reason: "interrupted" },
  });
  expect(recovered.points.find((point) => point.boundary === "tool.finished")?.operationId).toBe(
    MINTED,
  );
});

function traceStart(attempt: number) {
  beginRecordedTool({
    runId: RUN,
    fence: attempt,
    name: "destination.write",
    executionId: ORIGINAL,
    argumentDigest: DIGEST,
    unfinished: [],
  });
}
