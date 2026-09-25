import type { TaskContract } from "../tasks/catalog.js";
import { referenceSolution } from "../tasks/reference.js";
import type { OutcomeObservation } from "./outcome.js";
import { gradeOutcome } from "./outcome.js";

export function validateTaskContract(task: TaskContract) {
  const solution = referenceSolution(task);
  const pin = {
    runtime: "pi",
    provider: "openai-compatible",
    model: "scoreboard-v1",
    effort: null,
    computer: "fixture",
  };
  const observed: OutcomeObservation = {
    result: solution.result,
    reply: "Saved the requested result.",
    files: { ...task.files, ...solution.files },
    state: task.initialState.map((row) => {
      const update = solution.updates.find((item) => item.id === row.id);
      return update ? { ...update, revision: update.revision + 1 } : structuredClone(row);
    }),
    effects: solution.updates.map((update) => ({
      id: update.id,
      revision: update.revision + 1,
      authorized: true,
    })),
    tools: ["read_file", "write_file", ...solution.updates.map(() => "SCOREBOARD_UPDATE")],
    expectedPin: pin,
    observedPin: pin,
    elapsedMs: 0,
    terminal: "completed",
  };
  const controls: Record<string, OutcomeObservation> = {
    "reply-redaction": { ...observed, reply: "Saved. synthetic-private-sentinel" },
    "wrong-fact": { ...observed, result: { ...solution.result, facts: {} } },
    "missing-citation": { ...observed, result: { ...solution.result, citations: [] } },
    "unsolicited-effect": {
      ...observed,
      effects: [...observed.effects, { id: "unsolicited", revision: 1, authorized: false }],
    },
    "false-completion": { ...observed, files: { ...task.files } },
    "wrong-pin": { ...observed, observedPin: { model: "wrong" } },
    "deadline-miss": { ...observed, elapsedMs: task.deadlineMs + 1 },
  };
  const negativeControls = Object.entries(controls).map(([id, control]) => ({
    id,
    rejected: !gradeOutcome(task, control).passed,
  }));
  return {
    taskId: task.id,
    department: task.department,
    grade: gradeOutcome(task, observed),
    negativeControls,
    passed:
      gradeOutcome(task, observed).passed && negativeControls.every((control) => control.rejected),
    elapsedMs: null,
    clock: "virtual",
    liveAgentSuccess: null,
  };
}
