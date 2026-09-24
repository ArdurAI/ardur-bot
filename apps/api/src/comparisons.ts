import type { ComparisonDeps } from "@ardurbot/adapters";
import { comparisonParticipants, mergeComparison, startComparison } from "@ardurbot/adapters";
import type { Actor, ComparisonMerge, ComparisonStart } from "@ardurbot/contracts";
import { ComparisonExportSchema, DELEGATION_LIMITS } from "@ardurbot/contracts";
import { listComparisons, readComparison } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

export function createComparisons(deps: ComparisonDeps) {
  const authorize = async (actor: Actor) => {
    const member = await deps.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    if (!member) throw new ORPCError("FORBIDDEN");
    return { spaceId: actor.spaceId, userId: actor.userId };
  };
  return {
    async previewMerge(actor: Actor, input: { id: string; botId: string }) {
      const scope = await authorize(actor);
      await readComparison(deps.prisma, scope, input.id);
      return (await comparisonParticipants(deps, scope, [input.botId]))[0]!.participant;
    },
    async preview(actor: Actor, input: ComparisonStart) {
      const scope = await authorize(actor);
      const participants = await comparisonParticipants(deps, scope, input.participantBotIds);
      const runs = participants.length + Number(input.reserveMerge);
      return {
        participants: participants.map((entry) => entry.participant),
        runs,
        tokens: runs * DELEGATION_LIMITS.reservationTokens,
      };
    },
    async create(actor: Actor, input: ComparisonStart) {
      return startComparison(deps, await authorize(actor), input);
    },
    async merge(actor: Actor, input: ComparisonMerge) {
      return mergeComparison(deps, await authorize(actor), input);
    },
    async get(actor: Actor, id: string) {
      return readComparison(deps.prisma, await authorize(actor), id);
    },
    async list(actor: Actor) {
      return listComparisons(deps.prisma, await authorize(actor));
    },
    async export(actor: Actor, id: string) {
      return ComparisonExportSchema.parse({
        format: "ardurbot.comparison",
        version: 1,
        exportedAt: new Date().toISOString(),
        comparison: await readComparison(deps.prisma, await authorize(actor), id),
      });
    },
  };
}
