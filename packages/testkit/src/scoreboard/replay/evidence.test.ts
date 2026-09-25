import { expect, it } from "vitest";
import { contentDigest } from "../manifest.js";
import type { TaskTrialEvidence } from "./evidence.js";
import { replayTaskEvidence } from "./evidence.js";

const trial: TaskTrialEvidence = {
  taskId: "task-01",
  trialId: "trial-01",
  sessionId: "session-01",
  traceId: "trace-01",
  pairId: null,
  fixtureHash: contentDigest("fixture"),
  graderHash: contentDigest("grader"),
  outcome: "failed",
  grade: { passed: false, criticalPassed: true, withinDeadline: true },
};

it("retains failed attempts and marks every unrun task incomplete in the predecessor contract", () => {
  const tasks = replayTaskEvidence([trial]);
  expect(tasks).toHaveLength(24);
  expect(tasks[0]!.trials[0]!.outcome).toBe("failed");
  expect(tasks[0]!.trials[0]!.passed).toBe(false);
  expect(
    tasks
      .slice(1)
      .every((task) => task.status === "incomplete" && task.missingReason === "not-measured"),
  ).toBe(true);
});

it("rejects duplicate attempts, unknown tasks and mixed grader versions", () => {
  expect(() => replayTaskEvidence([trial, trial])).toThrow();
  expect(() => replayTaskEvidence([{ ...trial, taskId: "task-25" }])).toThrow();
  expect(() =>
    replayTaskEvidence([
      trial,
      { ...trial, trialId: "second", graderHash: contentDigest("different") },
    ]),
  ).toThrow();
});
