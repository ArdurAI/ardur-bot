import type { Actor, RuntimePin } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { createLearningService } from "./learning.js";

it("defaults to disabled, captures medium effort, and only lets a space owner configure review", async () => {
  const actor = { spaceId: "space", userId: "owner" } as Actor;
  let row: Record<string, unknown> | null = null;
  const member = vi.fn(async () => ({ role: "owner" }));
  const prisma = {
    spaceMember: { findUnique: member },
    spaceLearningConfig: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        row = create;
        return row;
      }),
    },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: { id: "connection", provider: "openai-compatible" },
        modelId: "local-model",
        isDefault: true,
      })),
    },
  };
  const service = createLearningService({
    prisma: prisma as unknown as PrismaClient,
    jobs: {} as never,
  });
  const initial = await service.settings(actor);
  expect(initial).toMatchObject({
    enabled: false,
    destination: { modelId: "local-model", effort: "medium", credentialId: "connection" },
  });
  const configured = await service.configure(actor, { enabled: true });
  expect(configured.reviewerPin).toEqual(initial.destination);
  expect(row).toMatchObject({
    configuredBy: actor.userId,
    botDailyTokens: 30000,
    spaceDailyTokens: 150000,
  });
  prisma.spaceModelPreference.findFirst.mockResolvedValueOnce({
    credential: { id: "different", provider: "openai-compatible" },
    modelId: "other-model",
    isDefault: true,
  });
  expect((await service.settings(actor)).destination).toEqual(initial.destination);
  member.mockResolvedValueOnce({ role: "member" });
  await expect(
    service.configure(actor, { enabled: true, reviewerPin: initial.destination as RuntimePin }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(prisma.spaceLearningConfig.upsert).toHaveBeenCalledOnce();
});

it("lists scoped proposals with separate counts and opens only linked, surviving evidence", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const proposal = {
    id: "proposal",
    type: "memory",
    scope: { spaceId: "space", userId: "user", botId: "bot" },
    target: {},
    proposedContent: "Use numbered steps.",
    rationale: "Requested format",
    evidenceIds: ["evidence"],
    confidence: { label: "model estimate", value: 0.8 },
    diff: "+Use numbered steps.",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "pending",
    evidenceWatermark: "server-only",
  };
  const row = { body: proposal, status: "pending", threadId: "thread", historyGeneration: 2 };
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => ({ role: "member" })) },
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot" })),
      findMany: vi.fn(async () => [{ id: "bot", name: "Helper" }]),
    },
    learningProposal: {
      findMany: vi.fn(async () => [row]),
      count: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2),
      findFirst: vi.fn(async () => row),
    },
    reviewExecution: { findMany: vi.fn(async () => []) },
    thread: { findFirst: vi.fn(async () => ({ id: "thread" }) as { id: string } | null) },
    proposalEvidence: {
      findFirst: vi.fn(async () => ({
        body: {
          id: "evidence",
          kind: "instruction-span",
          sourceClass: "human-message",
          actorId: "user",
          runId: "run",
          threadId: "thread",
          eventIds: [],
          redactionVersion: 1,
          excerpt: "Use numbered steps.",
        },
      })),
    },
  };
  const service = createLearningService({
    prisma: prisma as unknown as PrismaClient,
    jobs: {} as never,
  });
  const list = await service.list(actor, "bot");
  expect(list).toMatchObject({ pendingCount: 3, appliedThisWeek: 2 });
  expect(list.proposals[0]).not.toHaveProperty("evidenceWatermark");
  expect(prisma.learningProposal.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { spaceId: "space", userId: "user", botId: "bot" } }),
  );
  expect((await service.evidence(actor, "proposal", "evidence")).excerpt).toBe(
    "Use numbered steps.",
  );
  await expect(service.evidence(actor, "proposal", "unrelated")).rejects.toThrow();
  prisma.thread.findFirst.mockResolvedValueOnce(null);
  await expect(service.evidence(actor, "proposal", "evidence")).rejects.toThrow();
  expect(prisma.proposalEvidence.findFirst).toHaveBeenCalledTimes(1);
});
