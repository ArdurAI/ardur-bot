import type { Actor } from "@ardurbot/contracts";
import type { ProtectedLocationsPatchInput } from "@ardurbot/contracts/protected-locations";
import {
  ProtectedLocationsPatchError,
  ProtectedLocationsPatchInputSchema,
} from "@ardurbot/contracts/protected-locations";
import type { PrismaClient } from "@ardurbot/db";
import {
  IsolationError,
  readProtectedLocations,
  updateBotProtectedLocationGrants,
  updateSpaceProtectedLocations,
} from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import { ZodError } from "zod";

async function protectedLocationsResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    if (error instanceof ProtectedLocationsPatchError || error instanceof ZodError) {
      throw new ORPCError("BAD_REQUEST");
    }
    throw error;
  }
}

export async function getProtectedLocations(prisma: PrismaClient, actor: Actor, botId?: string) {
  if (botId !== undefined) {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    });
    if (!bot) throw new ORPCError("NOT_FOUND");
  }
  return protectedLocationsResult(() =>
    readProtectedLocations(prisma, { spaceId: actor.spaceId, botId }),
  );
}

export async function patchProtectedLocations(
  prisma: PrismaClient,
  actor: Actor,
  input: ProtectedLocationsPatchInput,
) {
  return protectedLocationsResult(async () => {
    const parsed = ProtectedLocationsPatchInputSchema.parse(input);
    if ("botId" in parsed) {
      return updateBotProtectedLocationGrants(prisma, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: parsed.botId,
        patch: parsed.patch,
      });
    }
    const member = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    if (!member || !["owner", "admin"].includes(member.role)) throw new ORPCError("FORBIDDEN");
    return updateSpaceProtectedLocations(prisma, { spaceId: actor.spaceId, patch: parsed.patch });
  });
}
