import type { TraceBoundary, TraceOutcome } from "@ardurbot/contracts";
import { afterEach, expect, it } from "vitest";
import { startScoreboardTrace, tracePoint } from "../../../../adapters/src/scoreboard-trace.js";
import type { MatrixResult } from "../experiments/catalog.js";
import { matrixEvidence } from "../experiments/evidence.js";
import { traceTerminals } from "../trace-collector.js";
import { faultTraceEvidence } from "./trace.js";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

/**
 * What the fault worker records for one attempt, in order, as observed on a real matrix run: the
 * queue boundaries carry no attempt, everything from the lease on carries the lease fence, and
 * the tool boundaries name the scripted call.
 */
const QUEUED: readonly TraceBoundary[] = ["job.submitted", "job.enqueued", "job.dequeued"];
const STARTED: readonly TraceBoundary[] = [
  "lease.acquired",
  "context.ready",
  "runtime.started",
  "runtime.first",
  "runtime.text",
  "text.safe",
  "tool.started",
];

type Step = TraceBoundary | [TraceBoundary, TraceOutcome];

function capture(
  run: string,
  processId: string,
  timeOrigin: number,
  attempt: number,
  steps: readonly Step[],
) {
  const trace = startScoreboardTrace({ processId, timeOrigin, now: () => 1 });
  stop = trace.stop;
  try {
    steps.forEach((step, index) => {
      const [boundary, outcome] = typeof step === "string" ? [step, undefined] : step;
      const detail = QUEUED.includes(boundary)
        ? {}
        : {
            attempt,
            ...(boundary.startsWith("tool.") ? { operationId: `${run}:destination.write:0` } : {}),
            ...(outcome ? { outcome } : {}),
          };
      tracePoint(run, boundary, detail, 10 + index);
    });
    return trace.snapshot();
  } finally {
    trace.stop();
    stop = undefined;
  }
}

/** Each case runs on its own database in its own two worker processes. */
const killed = (id: string, steps: readonly Step[]) =>
  capture(`${id}-run`, `${id}-interrupted`, 1_700_000_000_000, 1, steps);
const recovering = (id: string, steps: readonly Step[]) =>
  capture(`${id}-run`, `${id}-recovered`, 1_700_000_004_000, 2, steps);

/** Killed mid-tool, then recovered on the next fence into `ending`. */
function recovered(id: string, ending: readonly Step[]): MatrixResult {
  return result(
    id,
    killed(id, [...QUEUED, ...STARTED]),
    recovering(id, [...QUEUED, ...STARTED, ...ending]),
  );
}

function result(
  id: string,
  before: ReturnType<typeof capture>,
  after: ReturnType<typeof capture>,
): MatrixResult {
  return {
    id,
    experiment: "O9",
    tier: "T1",
    status: "passed",
    checks: { killedAtBoundary: true },
    measurements: {
      before: { trace: faultTraceEvidence(before) },
      after: { autonomousCompletion: false, trace: faultTraceEvidence(after) },
    },
    coverage: [],
    gaps: [],
  };
}

const COMPLETED: readonly Step[] = [
  ["tool.finished", "success"],
  ["terminal.committed", "success"],
];
const WAITING: readonly Step[] = [["tool.finished", "uncertain"], "wait.approval"];

it("completes crash-03 with its controls and crash-07 from the traces the fault worker records", () => {
  const crashes = matrixEvidence([
    recovered("crash-03", COMPLETED),
    recovered("crash-03-pin", COMPLETED),
    // The revoked approval makes the recovered attempt pause instead of finishing.
    recovered("crash-03-revoke", WAITING),
    // Killed once the pause is recorded; recovery finds the run waiting and runs nothing.
    result(
      "crash-07",
      killed("crash-07", [...QUEUED, ...STARTED, ...WAITING]),
      recovering("crash-07", []),
    ),
  ]).crashes;
  expect(crashes.find((row) => row.id === "crash-03")).toMatchObject({
    status: "complete",
    missingReason: null,
    recovery: "safe-retry",
    safetyPassed: true,
  });
  expect(crashes.find((row) => row.id === "crash-07")).toMatchObject({
    status: "complete",
    missingReason: null,
    recovery: "automatic-recovery",
    safetyPassed: true,
  });
});

it("still needs the recovering process's trace when the killed run had not ended", () => {
  const [crash] = matrixEvidence([
    result("crash-05", killed("crash-05", [...QUEUED, ...STARTED]), recovering("crash-05", [])),
  ]).crashes.filter((row) => row.id === "crash-05");
  expect(crash).toMatchObject({ status: "incomplete", missingReason: "trace-links-missing" });
});

it("ends a trace at its pause only when no later lease resumed the run", () => {
  const paused = killed("crash-07", [...STARTED, ...WAITING]).points;
  expect(traceTerminals(paused).map((point) => point.boundary)).toEqual(["wait.approval"]);
  const resumed = [...paused, ...recovering("crash-07", ["lease.acquired"]).points];
  expect(traceTerminals(resumed)).toEqual([]);
  const finished = [
    ...resumed,
    ...recovering("crash-07", [["terminal.committed", "success"]]).points,
  ];
  expect(traceTerminals(finished).map((point) => point.boundary)).toEqual(["terminal.committed"]);
});
