import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { DISPATCH_POLICY_LAYER, dispatchEnabled } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

export function createSystemSettings(prisma: PrismaClient) {
  const get = async (actor: Actor) => ({
    enabled: await dispatchEnabled(prisma, actor.spaceId),
    canChange: actor.isDeploymentOwner,
  });
  return {
    get,
    async set(actor: Actor, enabled: boolean) {
      if (!actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
      const key = { layer: DISPATCH_POLICY_LAYER, subjectId: actor.spaceId };
      const scopes = enabled ? ["dispatch"] : [];
      await prisma.remoteAuthorityPolicy.upsert({
        where: { layer_subjectId: key },
        create: { ...key, scopes },
        update: { scopes },
      });
      return get(actor);
    },
  };
}
