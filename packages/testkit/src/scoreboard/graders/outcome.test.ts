import { expect, it } from "vitest";
import { getTask } from "../tasks/catalog.js";
import { gradeOutcome, reportOutcomeCohort } from "./outcome.js";

const SENTENCE = "The workspace could not be inspected.";

function observation(files: Record<string, string> | undefined, error?: string) {
  const task = getTask("task-01");
  return {
    task,
    observed: {
      result: { facts: {}, citations: [], unresolved: [] },
      reply: "Saved.",
      files,
      state: [...task.initialState],
      effects: [],
      tools: [],
      expectedPin: { model: "scoreboard-v1" },
      observedPin: { model: "scoreboard-v1" },
      elapsedMs: 1,
      terminal: "uncertain" as const,
      ...(error ? { snapshot: { error } } : {}),
    },
  };
}

it("grades a snapshot error as uninspected and leaves it out of the check failures", () => {
  const hidden = observation({ "brief.md": "synthetic" }, "read failed");
  const grade = gradeOutcome(hidden.task, hidden.observed);
  expect(grade.uninspected).toBe(true);
  expect(grade.passed).toBe(false);
  expect(grade.withinDeadline).toBeNull();
  expect(grade.reasons).toEqual([SENTENCE]);
  for (const value of Object.values(grade.checks)) expect(value).toBeNull();

  const missing = observation(undefined);
  expect(gradeOutcome(missing.task, missing.observed).uninspected).toBe(true);

  const wrong = observation({ ...hidden.task.files });
  const missed = gradeOutcome(wrong.task, wrong.observed);
  expect(missed.uninspected).toBe(false);
  expect(missed.checks.facts).toBe(false);
  expect(reportOutcomeCohort([grade, missed])).toEqual({
    uninspected: 1,
    failures: {
      facts: 1,
      citations: missed.checks.citations === false ? 1 : 0,
      pin: missed.checks.pin === false ? 1 : 0,
      files: missed.checks.files === false ? 1 : 0,
    },
  });
});
