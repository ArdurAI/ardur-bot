import type { ObservationExposure, ObservationRun } from "./learning-outcomes.js";

const createdAt = new Date("2026-09-10T00:00:00Z"),
  now = new Date("2026-09-17T00:00:00Z");
export function observationRun(id: string, day: number): ObservationRun {
  const startedAt = new Date(`2026-09-${String(day).padStart(2, "0")}T01:00:00Z`);
  return {
    id,
    botId: "bot",
    pin: "pin",
    taskClass: "routine:weekly",
    startedAt,
    completedAt: new Date(startedAt.getTime() + 60000),
    status: "completed",
    feedback: [],
    steering: [],
    denials: [],
    failures: [],
    tokens: 100,
  };
}
export function outcomeFixture() {
  const before = Array.from({ length: 9 }, (_, i) => observationRun(`b${i}`, 4));
  const after = Array.from({ length: 7 }, (_, i) => observationRun(`a${i}`, 11));
  for (const r of before.slice(0, 3))
    r.feedback.push({
      id: `f-${r.id}`,
      at: r.completedAt!,
      rating: "negative",
      reason: "Use a table.",
      retracted: false,
    });
  after[0]!.feedback.push({
    id: "f-a0",
    at: after[0]!.completedAt!,
    rating: "negative",
    reason: "Use a table.",
    retracted: false,
  });
  after[1]!.steering.push({
    id: "s-a1",
    at: after[1]!.completedAt!,
    human: true,
    kind: "correction",
  });
  const exposures: ObservationExposure[] = after.map((r) => ({
    runId: r.id,
    revisionId: "doc:2",
    at: r.startedAt,
    truncated: false,
  }));
  return {
    documentId: "doc",
    revisionId: "doc:2",
    createdAt,
    now,
    runs: [...before, ...after],
    exposures,
  };
}
