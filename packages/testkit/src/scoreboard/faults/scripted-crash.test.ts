import type { TraceBoundary } from "@ardurbot/contracts";
import { nextFence } from "@ardurbot/core";
import { afterEach, expect, it } from "vitest";
import { startScoreboardTrace, tracePoint } from "../../../../adapters/src/scoreboard-trace.js";
import type { MatrixResult } from "../experiments/catalog.js";
import { matrixEvidence } from "../experiments/evidence.js";
import { LOCAL_TRACE_BOUNDARIES } from "../trace-collector.js";
import { faultTraceEvidence } from "./trace.js";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

const RUN = "run-scripted";
const ORIGINAL = `${RUN}:destination.write:0`;

function scriptedBoundaries(): TraceBoundary[] {
  return LOCAL_TRACE_BOUNDARIES.filter(
    (boundary) => !boundary.startsWith("provider.") && boundary !== "text.published",
  );
}

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

function recordBoundaries(boundaries: readonly TraceBoundary[], attempt: number, at: number) {
  let cursor = at;
  for (const boundary of boundaries) {
    const detail =
      boundary === "terminal.committed"
        ? { outcome: "success" as const }
        : boundary.startsWith("tool.")
          ? { operationId: ORIGINAL, attempt }
          : {};
    tracePoint(RUN, boundary, detail, cursor);
    cursor += 1;
  }
}

function crashFrom(runtime: "scripted" | "pi") {
  const scripted = scriptedBoundaries();
  const killed = scripted.filter(
    (boundary) => boundary !== "tool.finished" && boundary !== "terminal.committed",
  );
  const attempt = 3;
  const before = capture("interrupted-worker", 1_700_000_000_000, () => {
    recordBoundaries(killed, attempt, 10);
  });
  const after = capture("recovered-worker", 1_700_000_004_000, () => {
    tracePoint(
      RUN,
      "tool.finished",
      { operationId: ORIGINAL, attempt: nextFence(attempt), outcome: "success" },
      12,
    );
    tracePoint(RUN, "terminal.committed", { outcome: "success" }, 13);
  });
  const result: MatrixResult = {
    id: "crash-04",
    experiment: "O9",
    tier: "T1",
    status: "passed",
    checks: { killedAtBoundary: true },
    measurements: {
      before: { trace: faultTraceEvidence(before, runtime) },
      after: { autonomousCompletion: false, trace: faultTraceEvidence(after, runtime) },
    },
    coverage: [],
    gaps: [],
  };
  return matrixEvidence([result]).crashes.find((row) => row.id === "crash-04");
}

it("completes a scripted fault-worker crash under the recorded scripted boundary list", () => {
  const scripted = crashFrom("scripted");
  expect(scripted).toMatchObject({
    status: "complete",
    missingReason: null,
    safetyPassed: true,
    recovery: "explicit-uncertainty",
  });
  const full = crashFrom("pi");
  expect(full).toMatchObject({
    status: "incomplete",
    missingReason: "trace-links-missing",
    safetyPassed: null,
    recovery: null,
  });
});
