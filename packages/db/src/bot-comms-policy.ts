import type { Actor, BotCommunicationPolicy, PeerEffectDescriptor } from "@ardurbot/contracts";
import { PeerEffectDescriptorsSchema } from "@ardurbot/contracts";
import {
  PEER_GOAL_SENDS_PER_HOUR,
  PEER_GOAL_WAKES_PER_HOUR,
  PEER_PAIR_PER_MINUTE,
  PEER_SPACE_SENDS_PER_HOUR,
  PEER_SPACE_WAKES_PER_HOUR,
  peerLimitWindowKey,
  peerPairKey,
} from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Tx = Prisma.TransactionClient;
type Scope = { spaceId: string; userId: string; groupId?: string | null };

async function scopedGroup(tx: Tx | PrismaClient, scope: Scope) {
  if (!scope.groupId) return;
  const group = await tx.chatGroup.findFirst({
    where: { id: scope.groupId, spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
    select: { id: true },
  });
  if (!group) throw new IsolationError();
}

export async function peerTrafficPaused(tx: Tx | PrismaClient, scope: Scope): Promise<boolean> {
  const policies = await tx.botCommunicationPolicy.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      scopeKey: { in: ["space", ...(scope.groupId ? [`group:${scope.groupId}`] : [])] },
    },
    select: { paused: true, enabled: true },
  });
  return policies.some((policy) => policy.paused || !policy.enabled);
}

/** The space policy row is the serial lock for quota-sensitive sends across roots. */
export async function lockPeerTrafficPolicy(tx: Tx, scope: Scope) {
  await tx.botCommunicationPolicy.upsert({
    where: {
      spaceId_userId_scopeKey: { spaceId: scope.spaceId, userId: scope.userId, scopeKey: "space" },
    },
    create: { spaceId: scope.spaceId, userId: scope.userId, scopeKey: "space" },
    update: {},
  });
  await tx.$queryRaw`SELECT id FROM bot_communication_policies WHERE "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} AND "scopeKey" = 'space' FOR UPDATE`;
  return peerTrafficPaused(tx, scope);
}

export type PeerLimitReason =
  | "pair-rate"
  | "goal-traffic"
  | "space-traffic"
  | "goal-wakes"
  | "space-wakes";

export async function checkPeerTrafficLimits(
  tx: Tx,
  input: Scope & {
    goalId: string;
    senderBotId: string;
    recipientBotId: string;
    wakes: boolean;
    now: Date;
  },
): Promise<PeerLimitReason | null> {
  const minute = new Date(input.now.getTime() - 60_000);
  const hour = new Date(input.now.getTime() - 3_600_000);
  const base = { spaceId: input.spaceId, userId: input.userId };
  const pairCount = await tx.botMessageDelivery.count({
    where: {
      ...base,
      pairKey: peerPairKey(input.senderBotId, input.recipientBotId),
      createdAt: { gt: minute },
    },
  });
  if (pairCount >= PEER_PAIR_PER_MINUTE) return "pair-rate";
  const [goalSends, spaceSends] = await Promise.all([
    tx.botMessageDelivery.count({
      where: { ...base, goalId: input.goalId, createdAt: { gt: hour } },
    }),
    tx.botMessageDelivery.count({ where: { ...base, createdAt: { gt: hour } } }),
  ]);
  if (goalSends >= PEER_GOAL_SENDS_PER_HOUR) return "goal-traffic";
  if (spaceSends >= PEER_SPACE_SENDS_PER_HOUR) return "space-traffic";
  if (input.wakes) {
    const wakeWhere = {
      ...base,
      createdAt: { gt: hour },
      state: { in: ["bound", "consumed"] },
      runId: { not: null },
    };
    const [goalWakes, spaceWakes] = await Promise.all([
      tx.botMessageWake.count({ where: { ...wakeWhere, goalId: input.goalId } }),
      tx.botMessageWake.count({ where: wakeWhere }),
    ]);
    const directWhere = {
      ...base,
      createdAt: { gt: hour },
      delegationId: { not: null },
      state: { in: ["delivered", "read", "replied"] },
    };
    const [goalDirect, spaceDirect] = await Promise.all([
      tx.botMessageDelivery.count({ where: { ...directWhere, goalId: input.goalId } }),
      tx.botMessageDelivery.count({ where: directWhere }),
    ]);
    if (goalWakes + goalDirect >= PEER_GOAL_WAKES_PER_HOUR) return "goal-wakes";
    if (spaceWakes + spaceDirect >= PEER_SPACE_WAKES_PER_HOUR) return "space-wakes";
  }
  return null;
}

export async function recordPeerTrafficBlock(
  tx: Tx,
  input: Scope & {
    reason: PeerLimitReason;
    now: Date;
    goalId?: string;
    senderBotId?: string;
    recipientBotId?: string;
  },
) {
  const duration = input.reason === "pair-rate" ? 60_000 : 3_600_000;
  const scopeKey =
    input.reason === "pair-rate" && input.senderBotId && input.recipientBotId
      ? `pair:${peerPairKey(input.senderBotId, input.recipientBotId)}`
      : input.reason.startsWith("goal-")
        ? `goal:${input.goalId ?? input.groupId}`
        : "space";
  const windowKey = peerLimitWindowKey(input.now, duration);
  const key = {
    spaceId: input.spaceId,
    userId: input.userId,
    scopeKey,
    reason: input.reason,
    windowKey,
  };
  const existing = await tx.peerTrafficBlock.findUnique({
    where: { spaceId_userId_scopeKey_reason_windowKey: key },
  });
  if (existing) {
    await tx.peerTrafficBlock.update({
      where: { id: existing.id },
      data: { refusedAttempts: { increment: 1 } },
    });
    return false;
  }
  await tx.peerTrafficBlock.create({ data: key });
  return true;
}

function policyView(
  row: {
    scopeKey: string;
    groupId: string | null;
    enabled: boolean;
    paused: boolean;
    revision: number;
  },
  effectivePaused: boolean,
): BotCommunicationPolicy {
  return {
    scope: row.scopeKey === "space" ? "space" : "group",
    groupId: row.groupId,
    enabled: row.enabled,
    paused: row.paused,
    effectivePaused,
    revision: row.revision,
  };
}

export async function getBotCommunicationPolicy(
  prisma: PrismaClient,
  actor: Actor,
  groupId?: string,
) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  await scopedGroup(prisma, { ...actor, groupId });
  const key = groupId ? `group:${groupId}` : "space";
  const row = await prisma.botCommunicationPolicy.findUnique({
    where: {
      spaceId_userId_scopeKey: { spaceId: actor.spaceId, userId: actor.userId, scopeKey: key },
    },
  });
  const effectivePaused = await peerTrafficPaused(prisma, { ...actor, groupId });
  return policyView(
    row ?? { scopeKey: key, groupId: groupId ?? null, enabled: true, paused: false, revision: 1 },
    effectivePaused,
  );
}

export async function setBotCommunicationPaused(
  prisma: PrismaClient,
  actor: Actor,
  input: { scope: "space" | "group"; groupId?: string; paused: boolean; expectedRevision: number },
) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  if ((input.scope === "group") !== Boolean(input.groupId))
    throw new Error("Group scope requires one group id.");
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await scopedGroup(tx, { ...actor, groupId: input.groupId });
      // The space row is always first, including group mutations, so admission
      // and pause cannot cross between policy inspection and run creation.
      await lockPeerTrafficPolicy(tx, { spaceId: actor.spaceId, userId: actor.userId });
      const scopeKey = input.groupId ? `group:${input.groupId}` : "space";
      await tx.botCommunicationPolicy.upsert({
        where: {
          spaceId_userId_scopeKey: { spaceId: actor.spaceId, userId: actor.userId, scopeKey },
        },
        create: { spaceId: actor.spaceId, userId: actor.userId, scopeKey, groupId: input.groupId },
        update: {},
      });
      await tx.$queryRaw`SELECT id FROM bot_communication_policies WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} AND "scopeKey" = ${scopeKey} FOR UPDATE`;
      const current = await tx.botCommunicationPolicy.findUniqueOrThrow({
        where: {
          spaceId_userId_scopeKey: { spaceId: actor.spaceId, userId: actor.userId, scopeKey },
        },
      });
      if (current.revision !== input.expectedRevision)
        throw new Error("Communication policy changed; refresh and try again.");
      const row =
        current.paused === input.paused
          ? current
          : await tx.botCommunicationPolicy.update({
              where: { id: current.id },
              data: {
                paused: input.paused,
                revision: { increment: 1 },
                pausedAt: input.paused ? new Date() : null,
                pausedByUserId: input.paused ? actor.userId : null,
              },
            });
      if (input.paused && !current.paused) {
        const deliveries = await tx.botMessageDelivery.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            ...(input.groupId ? { sourceGroupId: input.groupId } : {}),
            state: { in: ["queued", "delivered", "read"] },
            outcome: null,
          },
          select: { id: true, delegationId: true, inboundMessageId: true },
        });
        const ids = deliveries.map((delivery) => delivery.id);
        const wakes = ids.length
          ? await tx.botMessageWake.findMany({
              where: {
                deliveryIds: { hasSome: ids },
                state: { in: ["pending", "sealed", "retry_wait", "bound"] },
              },
              select: { id: true, runId: true, steeringMessageId: true },
            })
          : [];
        const directRuns = await tx.run.findMany({
          where: {
            delegationId: {
              in: deliveries.flatMap((d) => (d.delegationId ? [d.delegationId] : [])),
            },
            status: { in: ["queued", "leased", "running"] },
          },
          select: { id: true },
        });
        const affected = [
          ...new Set([
            ...wakes.flatMap((wake) => (wake.runId && !wake.steeringMessageId ? [wake.runId] : [])),
            ...directRuns.map((run) => run.id),
          ]),
        ];
        if (affected.length)
          await tx.run.updateMany({
            where: { id: { in: affected }, status: { in: ["queued", "leased", "running"] } },
            data: { cancelRequestedAt: new Date() },
          });
        if (wakes.length)
          await tx.botMessageWake.updateMany({
            where: { id: { in: wakes.map((wake) => wake.id) } },
            data: { nextAttemptAt: null },
          });
        const messageIds = deliveries.flatMap((delivery) =>
          delivery.inboundMessageId ? [delivery.inboundMessageId] : [],
        );
        if (messageIds.length)
          await tx.steeringMessage.deleteMany({
            where: { messageId: { in: messageIds }, claimedAt: null },
          });
      } else if (!input.paused && current.paused) {
        const goals = await tx.teamGoal.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            ...(input.groupId ? { groupId: input.groupId } : {}),
            status: "running",
          },
          select: { id: true },
        });
        await tx.botMessageWake.updateMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            goalId: { in: goals.map((goal) => goal.id) },
            state: { in: ["pending", "sealed", "retry_wait"] },
          },
          data: { nextAttemptAt: null },
        });
      }
      const effectivePaused = await peerTrafficPaused(tx, { ...actor, groupId: input.groupId });
      return policyView(row, effectivePaused);
    }),
  );
}

export async function listBotCommunicationDeliveries(
  prisma: PrismaClient,
  actor: Actor,
  input: { conversationId?: string; botId?: string; cursor?: string; limit: number },
) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const where = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.botId ? { OR: [{ senderBotId: input.botId }, { recipientBotId: input.botId }] } : {}),
  };
  if (
    input.cursor &&
    !(await prisma.botMessageDelivery.findFirst({
      where: { ...where, id: input.cursor },
      select: { id: true },
    }))
  )
    throw new IsolationError();
  const rows = await prisma.botMessageDelivery.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1,
  });
  return {
    items: rows.slice(0, input.limit).map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      senderBotId: row.senderBotId,
      recipientBotId: row.recipientBotId,
      intent: row.intent,
      state: row.state as
        | "held"
        | "queued"
        | "delivered"
        | "read"
        | "replied"
        | "denied"
        | "expired"
        | "cancelled"
        | "failed",
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      requestedEffects: PeerEffectDescriptorsSchema.parse(
        row.requestedEffects,
      ) as PeerEffectDescriptor[],
    })),
    nextCursor: rows.length > input.limit ? (rows[input.limit - 1]?.id ?? null) : null,
  };
}
