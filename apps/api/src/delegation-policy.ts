import type { Actor, LocalityPolicy } from "@ardurbot/contracts";
import { LocalityPolicySchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

export async function getModelDestinations(prisma: PrismaClient, actor: Actor, botId?: string) {
  const row = botId
    ? await prisma.bot.findFirstOrThrow({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      })
    : await prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
  return LocalityPolicySchema.parse(row.allowedModelDestinations ?? { mode: "any" });
}
export async function setModelDestinations(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; policy: LocalityPolicy },
) {
  if (input.botId)
    await prisma.bot.update({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
      data: { allowedModelDestinations: input.policy },
    });
  else {
    const member = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    if (!member || !["owner", "admin"].includes(member.role)) throw new ORPCError("FORBIDDEN");
    await prisma.space.update({
      where: { id: actor.spaceId },
      data: { allowedModelDestinations: input.policy },
    });
  }
  return { ok: true as const };
}
