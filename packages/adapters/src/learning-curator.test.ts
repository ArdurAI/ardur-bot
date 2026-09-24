import { SpaceLearningConfigInput } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { consolidateLearning } from "./learning-consolidation.js";
import {
  learnedSkillStale,
  possibleLearningRegression,
  runLearningCurator,
  saveCuratorProposal,
} from "./learning-curator.js";
import { outcomeFixture } from "./learning-outcomes.fixtures.js";
import { projectLearningObservation } from "./learning-outcomes.js";
import { policyCandidates, policySuppressed } from "./learning-policy.js";

const now = new Date("2026-09-23T00:00:00Z");
it("marks only unexposed, unprotected, non-routine learned skills stale and exempts recovery tags", () => {
  const input = {
    origin: "learned",
    protected: false,
    routineLinked: false,
    lifecycleTag: "normal",
    revisionCreatedAt: new Date("2026-08-01Z"),
    lastExposureAt: null,
  };
  expect(learnedSkillStale(input, now)).toBe(true);
  for (const override of [
    { protected: true },
    { routineLinked: true },
    { lifecycleTag: "recovery" },
    { lifecycleTag: "troubleshooting" },
    { origin: "user" },
    { lastExposureAt: new Date("2026-09-20Z") },
  ])
    expect(learnedSkillStale({ ...input, ...override }, now)).toBe(false);
});
it("requires three corrections, five runs in both windows and a strictly worse ratio", () => {
  const o = projectLearningObservation(outcomeFixture());
  expect(possibleLearningRegression(o)).toBe(false);
  o.correctionsAfter = { feedback: 2, steering: 1 };
  expect(possibleLearningRegression(o)).toBe(true);
  expect(possibleLearningRegression({ ...o, exposedRuns: 4 })).toBe(false);
  expect(possibleLearningRegression({ ...o, before: { ...o.before, runs: 4 } })).toBe(false);
  expect(possibleLearningRegression({ ...o, exposedRuns: 9 })).toBe(false);
});
it("defaults consolidation off and never accesses runtime or database when off", async () => {
  expect(SpaceLearningConfigInput.parse({}).consolidationEnabled).toBe(false);
  const run = vi.fn();
  expect(
    await consolidateLearning(
      { runtime: { run } } as never,
      { spaceId: "s", userId: "u" },
      [],
      { enabled: true, consolidationEnabled: false } as never,
      now,
    ),
  ).toEqual({ tokens: 0, proposalIds: [] });
  expect(run).not.toHaveBeenCalled();
});
it("only suggests a read-classified tool after five distinct human approvals for one bot in fourteen days", () => {
  const approvals = Array.from({ length: 5 }, (_, i) => ({
    id: `a${i}`,
    botId: "bot",
    tool: "GMAIL_LIST_MESSAGES",
    at: new Date("2026-09-22Z"),
    userId: "user",
  }));
  expect(policyCandidates(approvals.slice(0, 4), "user", now)).toEqual([]);
  expect(policyCandidates([...approvals, approvals[0]!], "user", now)).toMatchObject([
    { botId: "bot", count: 5, tool: "GMAIL_LIST_MESSAGES" },
  ]);
  for (const change of [
    { tool: "GMAIL_SEND_EMAIL" },
    { tool: "GMAIL_LIST_AND_DELETE" },
    { tool: "shell" },
    { userId: "someone-else" },
    { at: new Date("2026-09-01Z") },
  ])
    expect(
      policyCandidates(
        approvals.map((a) => ({ ...a, ...change })),
        "user",
        now,
      ),
    ).toEqual([]);
  expect(
    policyCandidates(
      approvals.map((a, i) => ({ ...a, botId: i < 3 ? "one" : "two" })),
      "user",
      now,
    ),
  ).toEqual([]);
  expect(policySuppressed(new Date("2026-09-01Z"), now)).toBe(true);
  expect(policySuppressed(new Date("2026-08-24Z"), now)).toBe(false);
});
it("proposal persistence has no knowledge writer or approval-rule dependency", async () => {
  const create = vi.fn();
  const tx = {
    $queryRaw: vi.fn(),
    spaceMember: { findUnique: async () => ({ role: "owner" }) },
    bot: { findFirst: async () => ({ id: "b" }) },
    thread: { updateMany: async () => ({ count: 1 }) },
    learningSuppression: { findUnique: async () => null },
    learningProposal: { findMany: async () => [], create },
    proposalEvidence: { create: vi.fn() },
    reviewExecution: { create: vi.fn() },
    learningAudit: { create: vi.fn() },
  };
  await saveCuratorProposal(
    { $transaction: (action: (tx: unknown) => unknown) => action(tx) } as never,
    {
      proposal: {
        id: "p",
        type: "memory",
        operation: "revert-suggestion",
        scope: { spaceId: "s", userId: "u", botId: "b" },
        target: { documentId: "d" },
        proposedContent: "",
        evidenceIds: ["e"],
        expiresAt: "2026-10-01T00:00:00Z",
        provenance: { reviewerPin: {} },
      } as never,
      runId: "r",
      threadId: "t",
      historyGeneration: 0,
    },
    now,
  );
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "pending" }) }),
  );
});

it("does not persist a curator proposal after its source generation was cleared", async () => {
  const create = vi.fn();
  const tx = {
    $queryRaw: vi.fn(),
    spaceMember: { findUnique: async () => ({ role: "owner" }) },
    bot: { findFirst: async () => ({ id: "b" }) },
    thread: { updateMany: async () => ({ count: 0 }) },
    learningProposal: { create },
  };
  const persisted = await saveCuratorProposal(
    { $transaction: (action: (tx: unknown) => unknown) => action(tx) } as never,
    {
      proposal: {
        id: "p",
        type: "memory",
        scope: { spaceId: "s", userId: "u", botId: "b" },
        target: {},
        proposedContent: "",
        evidenceIds: ["e"],
      } as never,
      runId: "r",
      threadId: "t",
      historyGeneration: 0,
    },
    now,
  );
  expect(persisted).toBe(false);
  expect(create).not.toHaveBeenCalled();
});

it("a deterministic pass records a content-free report and never touches the model", async () => {
  const run = vi.fn();
  const report = vi.fn();
  const deps = {
    prisma: {
      spaceMember: { findUnique: async () => ({ role: "owner" }) },
      spaceLearningConfig: {
        findUnique: async () => ({
          enabled: true,
          consolidationEnabled: false,
          configuredBy: "user",
          reviewerPin: {
            provider: null,
            modelId: null,
            credentialId: null,
            effort: "medium",
            revision: 0,
          },
        }),
      },
      learningCuratorRun: { createMany: async () => ({ count: 1 }), update: report },
      agentSkill: { findMany: async () => [] },
      routine: { findMany: async () => [] },
      learningProposal: { findMany: async () => [] },
      externalEffect: { findMany: async () => [] },
    },
    runtime: { run },
  };
  await runLearningCurator(deps as never, { spaceId: "space", userId: "user" }, "check", now);
  expect(run).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith({
    where: { id: "check" },
    data: {
      checked: 0,
      staleIds: [],
      flaggedIds: [],
      proposalIds: [],
      tokens: 0,
      durationMs: expect.any(Number),
      status: "completed",
      completedAt: expect.any(Date),
    },
  });
});
