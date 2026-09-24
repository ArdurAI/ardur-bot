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
