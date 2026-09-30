import type {
  ProtectedLocationGrantsPatch,
  ProtectedLocationsPolicyPatch,
} from "@ardurbot/contracts/protected-locations";
import {
  applyProtectedLocationGrantsPatch,
  applyProtectedLocationsPolicyPatch,
  parseProtectedLocationsPolicy,
  protectedLocationGrantsAfterPolicyPatch,
  protectedLocations,
  protectedLocationViews,
} from "@ardurbot/contracts/protected-locations";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

type SpaceRow = { protectedLocations: unknown };
type BotRow = { id: string; protectedLocationGrants: unknown };

// Lock order is always space, then bot. Grant writers share the space lock;
// policy writers take it exclusively so removed ids cannot race new grants.
async function readLockedSpace(tx: Prisma.TransactionClient, spaceId: string) {
  const rows = await tx.$queryRaw<SpaceRow[]>`
    SELECT "protectedLocations" FROM spaces WHERE id = ${spaceId} FOR SHARE
  `;
  if (rows.length !== 1) throw new IsolationError();
  return rows[0]!;
}

export async function readProtectedLocations(
  prisma: PrismaClient,
  input: { spaceId: string; botId?: string },
) {
  return prisma.$transaction(async (tx) => {
    const space = await readLockedSpace(tx, input.spaceId);
    let grants: unknown = null;
    if (input.botId !== undefined) {
      const bots = await tx.$queryRaw<BotRow[]>`
        SELECT id, "protectedLocationGrants" FROM bots
        WHERE id = ${input.botId} AND "spaceId" = ${input.spaceId} FOR SHARE
      `;
      if (bots.length !== 1) throw new IsolationError();
      grants = bots[0]!.protectedLocationGrants;
    }
    return protectedLocationViews({ policy: space.protectedLocations, grants });
  });
}

export async function updateBotProtectedLocationGrants(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; botId: string; patch: ProtectedLocationGrantsPatch },
) {
  return prisma.$transaction(async (tx) => {
    const space = await readLockedSpace(tx, input.spaceId);
    const bots = await tx.$queryRaw<BotRow[]>`
      SELECT id, "protectedLocationGrants" FROM bots
      WHERE id = ${input.botId} AND "spaceId" = ${input.spaceId}
        AND "userId" = ${input.userId} FOR UPDATE
    `;
    if (bots.length !== 1) throw new IsolationError();
    const grants = applyProtectedLocationGrantsPatch(
      bots[0]!.protectedLocationGrants,
      input.patch,
      protectedLocations(parseProtectedLocationsPolicy(space.protectedLocations)),
    );
    await tx.bot.update({
      where: { id: input.botId, spaceId: input.spaceId, userId: input.userId },
      data: { protectedLocationGrants: grants },
    });
    return protectedLocationViews({ policy: space.protectedLocations, grants });
  });
}

export async function updateSpaceProtectedLocations(
  prisma: PrismaClient,
  input: { spaceId: string; patch: ProtectedLocationsPolicyPatch },
) {
  return prisma.$transaction(async (tx) => {
    const spaces = await tx.$queryRaw<SpaceRow[]>`
      SELECT "protectedLocations" FROM spaces WHERE id = ${input.spaceId} FOR UPDATE
    `;
    if (spaces.length !== 1) throw new IsolationError();
    const policy = applyProtectedLocationsPolicyPatch(spaces[0]!.protectedLocations, input.patch);
    if (input.patch.remove?.length) {
      const bots = await tx.$queryRaw<BotRow[]>`
        SELECT id, "protectedLocationGrants" FROM bots
        WHERE "spaceId" = ${input.spaceId} ORDER BY id FOR UPDATE
      `;
      for (const bot of bots) {
        await tx.bot.update({
          where: { id: bot.id, spaceId: input.spaceId },
          data: {
            protectedLocationGrants: protectedLocationGrantsAfterPolicyPatch(
              bot.protectedLocationGrants,
              input.patch,
              policy,
            ),
          },
        });
      }
    }
    await tx.space.update({
      where: { id: input.spaceId },
      data: { protectedLocations: policy },
    });
    return protectedLocationViews({ policy, grants: null });
  });
}
