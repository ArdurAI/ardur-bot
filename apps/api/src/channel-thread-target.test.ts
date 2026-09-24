import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { resolveThreadTarget } from "./thread-target.js";

it("resolves room history only inside the current owner's bot and space", async () => {
  const conversation = vi.fn().mockResolvedValue({ id: "room" });
  const prisma = {
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot", thread: { id: "personal" } }) },
    externalConversation: { findFirst: conversation },
  } as unknown as PrismaClient;
  const actor = { userId: "owner", spaceId: "space" } as Actor;
  await expect(
    resolveThreadTarget(prisma, actor, { botId: "bot", threadId: "room-thread" }),
  ).resolves.toMatchObject({ threadId: "room-thread" });
  expect(conversation).toHaveBeenCalledWith({
    where: { botId: "bot", userId: "owner", spaceId: "space", thread: { id: "room-thread" } },
    select: { id: true },
  });
  conversation.mockResolvedValue(null);
  await expect(
    resolveThreadTarget(prisma, actor, { botId: "bot", threadId: "another-owner" }),
  ).rejects.toThrow();
  await expect(resolveThreadTarget(prisma, actor, { botId: "bot" })).resolves.toMatchObject({
    threadId: "personal",
  });
});
