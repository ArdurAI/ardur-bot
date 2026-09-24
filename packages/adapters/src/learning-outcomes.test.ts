import type { DocumentRevision } from "@ardurbot/contracts";
import {
  LearningObservationSchema,
  learningObservationSummary,
  learningObservationUnmeasured,
} from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { outcomeFixture, observationRun as run } from "./learning-outcomes.fixtures.js";
import {
  learningFailureClass,
  observeLearningRevision,
  projectLearningObservation,
} from "./learning-outcomes.js";

const createdAt = new Date("2026-09-10T00:00:00Z"),
  now = new Date("2026-09-17T00:00:00Z");
it("keeps a long-running exposed run even when it started before the comparison window", async () => {
  const scope = { spaceId: "space", userId: "user", botId: "bot" };
  const exposures = [
    {
      runId: "long-run",
      documentId: "doc",
      revisionId: "doc:2",
      createdAt: new Date("2026-09-11Z"),
      truncated: false,
    },
  ];
  const findMany = vi.fn(async (query) => {
    const where = query.where;
    const selected = where.OR?.some((clause: { id?: { in: string[] } }) =>
      clause.id?.in.includes("long-run"),
    );
    return selected
      ? [
          {
            id: "long-run",
            ...scope,
            createdAt: new Date("2026-08-01Z"),
            startedAt: new Date("2026-08-01Z"),
            completedAt: new Date("2026-09-12Z"),
            status: "completed",
            trigger: "chat",
            routineId: null,
            runtimePin: null,
            usageRecords: [],
          },
        ]
      : [];
  });
  const prisma = {
    run: { findMany },
    runKnowledgeExposure: { findMany: vi.fn(async () => exposures) },
    feedback: { findMany: async () => [] },
    steeringSummary: { findMany: async () => [] },
    event: { findMany: async () => [] },
    externalEffect: { findMany: async () => [] },
  };
  const o = await observeLearningRevision(
    prisma as never,
    {
      documentId: "doc",
      revision: 2,
      createdAt: createdAt.toISOString(),
      scopeKey: { kind: "bot", ...scope },
    } as DocumentRevision,
    now,
  );
  expect(o.exposedRuns).toBe(1);
  expect(findMany.mock.calls[0]![0].where).toMatchObject(scope);
  expect(prisma.runKnowledgeExposure.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ thread: { spaceId: "space", userId: "user" } }),
    }),
  );
});
describe("learning observations", () => {
  it("joins distinct exposed runs with exact correction channels, denominators and equal windows", () => {
    const f = outcomeFixture();
    f.exposures.push({ ...f.exposures[0]!, truncated: true });
    f.runs.push(
      { ...run("other-pin", 4), pin: "different" },
      { ...run("other-bot", 4), botId: "other" },
      { ...run("other-task", 4), taskClass: "other" },
    );
    const o = LearningObservationSchema.parse(projectLearningObservation(f));
    expect(learningObservationSummary(o)).toBe(
      "2 corrections in 7 exposed runs; before: 3 in 9 comparable runs",
    );
    expect(o.correctionsAfter).toEqual({ feedback: 1, steering: 1 });
    expect(o.window).toEqual({ from: createdAt.toISOString(), to: now.toISOString() });
    expect(o.before.window).toEqual({
      from: "2026-09-03T00:00:00.000Z",
      to: createdAt.toISOString(),
    });
    expect(o.timeTokensDelta.tokens).toEqual({
      beforeSamples: 9,
      afterSamples: 7,
      beforeMean: 100,
      afterMean: 100,
      delta: 0,
    });
    expect(o.missing.join(" ")).toContain("truncated");
    expect(o.acceptance).toEqual({ accepted: 0, contracts: 0, evaluated: 0 });
  });
  it.each([0, 1, 4])(
    "keeps %i exposures unmeasured and does not treat silence as approval",
    (n) => {
      const f = outcomeFixture();
      f.exposures = f.exposures.slice(0, n);
      const o = projectLearningObservation(f);
      expect(learningObservationUnmeasured(o)).toBe(true);
      expect(o.missing).toContain("Not enough runs to tell");
      expect(o.timeTokensDelta.tokens.delta).toBeNull();
      expect(o.missing.join(" ")).toContain("No feedback is not approval");
    },
  );
  it("also withholds a comparison when the before sample is under five", () => {
    const f = outcomeFixture();
    f.runs = f.runs.filter((r) => !r.id.startsWith("b") || r.id === "b0");
    expect(learningObservationUnmeasured(projectLearningObservation(f))).toBe(true);
  });
  it("stratifies infrastructure failures and unknown denials without inventing task failure", () => {
    const f = outcomeFixture();
    const after = f.runs.filter((r) => r.id.startsWith("a"));
    for (const [i, classification] of (["pin", "provider", "integration"] as const).entries()) {
      after[i]!.status = "failed";
      after[i]!.failures.push({ at: after[i]!.completedAt!, classification });
    }
    after[3]!.status = "cancelled";
    after[4]!.denials.push({ id: "deny", at: after[4]!.completedAt!, classification: "unknown" });
    after[5]!.tokens = null;
    after[6]!.acceptance = { accepted: true };
    const o = projectLearningObservation(f);
    expect(o.failuresAfter).toEqual({ task: 0, pin: 1, provider: 1, integration: 1, unknown: 0 });
    expect(o.denialsAfter).toEqual({ inappropriate: 0, safety: 0, unknown: 1 });
    expect(o.cancellationsAfter).toBe(1);
    expect(o.timeTokensDelta.tokens.afterSamples).toBe(6);
    expect(o.acceptance).toEqual({ accepted: 1, evaluated: 1, contracts: 1 });
    expect(o.missing.join(" ")).toContain("missing usage is not zero");
  });
  it("excludes retracted, reasonless, pre-exposure and non-human corrections", () => {
    const f = outcomeFixture();
    const r = f.runs.find((r) => r.id === "a2")!;
    r.feedback = [
      { id: "early", at: createdAt, rating: "negative", reason: "correction", retracted: false },
      {
        id: "retracted",
        at: r.completedAt!,
        rating: "negative",
        reason: "correction",
        retracted: true,
      },
      { id: "empty", at: r.completedAt!, rating: "negative", reason: "", retracted: false },
      {
        id: "positive",
        at: r.completedAt!,
        rating: "positive",
        reason: "thanks",
        retracted: false,
      },
    ];
    r.steering = [
      { id: "peer", at: r.completedAt!, kind: "correction", human: false },
      { id: "requirement", at: r.completedAt!, kind: "added-requirement", human: true },
    ];
    expect(projectLearningObservation(f).correctionsAfter).toEqual({ feedback: 1, steering: 1 });
  });
});

it("does not mistake the generic provider error fallback for a classified outage", () => {
  expect(learningFailureClass("run.failed", { providerErrorKind: "other" })).toBe("unknown");
  expect(learningFailureClass("run.failed", { providerErrorKind: "rate-limit" })).toBe("provider");
  expect(
    learningFailureClass("run.failed", { runtimeProblem: {}, providerErrorKind: "auth" }),
  ).toBe("pin");
  expect(
    learningFailureClass("agent.tool.completed", { outcome: "error", errorClass: "integration" }),
  ).toBe("integration");
  expect(learningFailureClass("agent.tool.completed", { outcome: "succeeded" })).toBeNull();
});
