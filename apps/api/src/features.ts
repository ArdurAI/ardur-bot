import type {
  Actor,
  SpaceFeature,
  SpaceFeatureEntry,
  SpaceFeatureState,
} from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

const availability: Record<SpaceFeature, boolean> = { governance: false };

async function membership(prisma: PrismaClient, actor: Actor) {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  if (!member) throw new ORPCError("FORBIDDEN");
  return member;
}

export async function listSpaceFeatures(
  prisma: PrismaClient,
  actor: Actor,
): Promise<SpaceFeatureEntry[]> {
  await membership(prisma, actor);
  const rows = await prisma.spaceFeature.findMany({ where: { spaceId: actor.spaceId } });
  return (Object.keys(availability) as SpaceFeature[]).map((feature) => ({
    feature,
    state: !availability[feature]
      ? "unavailable"
      : rows.find((row) => row.feature === feature)?.state === "enabled"
        ? "enabled"
        : "disabled",
  }));
}

export async function setSpaceFeature(
  prisma: PrismaClient,
  actor: Actor,
  input: { feature: SpaceFeature; state: Exclude<SpaceFeatureState, "unavailable"> },
): Promise<SpaceFeatureEntry> {
  const member = await membership(prisma, actor);
  if (member.role !== "owner") throw new ORPCError("FORBIDDEN");
  if (!availability[input.feature])
    throw new ORPCError("BAD_REQUEST", { message: "This feature is unavailable in this build." });
  await prisma.spaceFeature.upsert({
    where: { spaceId_feature: { spaceId: actor.spaceId, feature: input.feature } },
    create: { spaceId: actor.spaceId, ...input },
    update: { state: input.state },
  });
  return input;
}
