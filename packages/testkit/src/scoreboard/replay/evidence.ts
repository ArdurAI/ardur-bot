import type { PerformanceEvidenceReport, TaskEvidence } from "../../performance-report.js";
import { createPerformanceEvidenceEnvelope } from "../../performance-report.js";
import { contentDigest, TASK_DEFINITIONS } from "../manifest.js";

export interface TaskTrialEvidence {
  taskId: string;
  trialId: string;
  sessionId: string;
  traceId: string;
  pairId: string | null;
  fixtureHash: string;
  graderHash: string;
  outcome: "success" | "failed" | "cancelled" | "timed-out" | "uncertain";
  grade: { passed: boolean; criticalPassed: boolean; withinDeadline: boolean };
}

/** W0-1's schema is the only scoreboard contract. Other streams' coverage is left intact. */
export function replayTaskEvidence(trials: TaskTrialEvidence[]): TaskEvidence[] {
  const known = new Set(TASK_DEFINITIONS.map((task) => task.id));
  const ids = new Set<string>();
  for (const trial of trials) {
    if (!known.has(trial.taskId) || ids.has(trial.trialId))
      throw new Error("Unknown task or duplicate replay trial");
    ids.add(trial.trialId);
    if (![trial.fixtureHash, trial.graderHash].every((hash) => /^[a-f0-9]{64}$/.test(hash)))
      throw new Error("Invalid task evidence hash");
  }
  return TASK_DEFINITIONS.map((definition): TaskEvidence => {
    const matches = trials.filter((trial) => trial.taskId === definition.id);
    const first = matches[0];
    if (
      matches.some(
        (trial) =>
          trial.fixtureHash !== first?.fixtureHash || trial.graderHash !== first?.graderHash,
      )
    )
      throw new Error("Do not combine different task or grader versions");
    return {
      id: definition.id,
      status: first ? "complete" : "incomplete",
      missingReason: first ? null : "not-measured",
      fixtureHash: first?.fixtureHash ?? null,
      graderHash: first?.graderHash ?? null,
      trials: matches.map((trial) => ({
        id: trial.trialId,
        sessionId: trial.sessionId,
        pairId: trial.pairId,
        traceId: trial.traceId,
        outcome: trial.outcome,
        passed: trial.grade.passed,
        criticalPassed: trial.grade.criticalPassed,
        withinDeadline: trial.grade.withinDeadline,
      })),
    };
  });
}

export function attachReplayTaskEvidence(
  report: PerformanceEvidenceReport,
  trials: TaskTrialEvidence[],
  binding: { commit: string; diffDigest: string | null; tier: "T0" | "T1" },
) {
  if (
    report.build.commit !== binding.commit ||
    report.build.diffDigest !== binding.diffDigest ||
    report.scenario.tier !== binding.tier
  )
    throw new Error("Replay evidence build or tier mismatch");
  if (report.tasks.some((task) => task.trials.length))
    throw new Error("Task evidence already attached; do not overwrite attempts");
  return createPerformanceEvidenceEnvelope({ ...report, tasks: replayTaskEvidence(trials) });
}

export function taskTrialId(taskId: string, attempt: number) {
  return `trial-${contentDigest({ taskId, attempt }).slice(0, 16)}`;
}
