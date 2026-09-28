import type { Actor, BotCommunicationPolicy, PeerEffectDescriptor } from "@ardurbot/contracts";
import { PeerEffectDescriptorsSchema } from "@ardurbot/contracts";
import {
  effectiveRemoteAuthority,
  PEER_GOAL_SENDS_PER_HOUR,
  PEER_GOAL_WAKES_PER_HOUR,
  PEER_PAIR_PER_MINUTE,
  PEER_SPACE_SENDS_PER_HOUR,
  PEER_SPACE_WAKES_PER_HOUR,
  peerLimitWindowKey,
  peerPairKey,
} from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { DeviceRequestError } from "./device-grants.js";
import { loadRemoteAuthority } from "./dispatch.js";
import { appendEventInTransaction } from "./events.js";
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
  if (input.wakes) return checkPeerWakeLimits(tx, input);
  return null;
}

/** Count actual admitted turns, including later failures and retries, by admission time. */
export async function checkPeerWakeLimits(
  tx: Tx,
  input: Pick<
    Parameters<typeof checkPeerTrafficLimits>[1],
    "spaceId" | "userId" | "goalId" | "now"
  > & {
    excludeDeliveryId?: string;
  },
): Promise<"goal-wakes" | "space-wakes" | null> {
  const base = { spaceId: input.spaceId, userId: input.userId };
  const hour = new Date(input.now.getTime() - 3_600_000);
  const wakeWhere = {
    ...base,
    createdAt: { gt: hour },
    clientNonce: { startsWith: "peer-wake:" },
  };
  const directWhere = {
    ...base,
    wakeAdmittedAt: { gt: hour },
    ...(input.excludeDeliveryId ? { id: { not: input.excludeDeliveryId } } : {}),
  };
  const [goalWakes, spaceWakes, goalDirect, spaceDirect] = await Promise.all([
    tx.run.count({ where: { ...wakeWhere, goalId: input.goalId } }),
    tx.run.count({ where: wakeWhere }),
    tx.botMessageDelivery.count({ where: { ...directWhere, goalId: input.goalId } }),
    tx.botMessageDelivery.count({ where: directWhere }),
  ]);
  if (goalWakes + goalDirect >= PEER_GOAL_WAKES_PER_HOUR) return "goal-wakes";
  if (spaceWakes + spaceDirect >= PEER_SPACE_WAKES_PER_HOUR) return "space-wakes";
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
  const goal = input.goalId
    ? await tx.teamGoal.findFirst({
        where: { id: input.goalId, spaceId: input.spaceId, userId: input.userId },
        select: { threadId: true, coordinatorBotId: true },
      })
    : null;
  if (goal)
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: goal.threadId,
      botId: goal.coordinatorBotId,
      type: "bot.traffic.limited",
      payload: { goalId: input.goalId, scopeKey, reason: input.reason, windowKey },
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
  remoteGrant?: { id: string; instanceId: string },
) {
  if (!actor.isDeploymentOwner) throw new IsolationError();
  if ((input.scope === "group") !== Boolean(input.groupId))
    throw new Error("Group scope requires one group id.");
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await scopedGroup(tx, { ...actor, groupId: input.groupId });
      if (remoteGrant) {
        if (!input.paused) throw new DeviceRequestError("Resume at home.");
        await tx.$queryRaw`SELECT id FROM device_grants WHERE id = ${remoteGrant.id} FOR UPDATE`;
        const liveGrant = await tx.deviceGrant.findFirst({
          where: {
            id: remoteGrant.id,
            instanceId: remoteGrant.instanceId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            revokedAt: null,
          },
        });
        const owner = await tx.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { ownerUserId: true },
        });
        if (!liveGrant || owner?.ownerUserId !== actor.userId)
          throw new DeviceRequestError("This action is unavailable from this device.");
        const affectedBots = await tx.bot.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
            ...(input.groupId ? { groupMembers: { some: { groupId: input.groupId } } } : {}),
          },
          select: { id: true },
        });
        if (
          !affectedBots.length ||
          !(
            await Promise.all(
              affectedBots.map(async (bot) =>
                effectiveRemoteAuthority(await loadRemoteAuthority(tx, liveGrant, bot.id)).includes(
                  "stop",
                ),
              ),
            )
          ).every(Boolean)
        )
          throw new DeviceRequestError("This action is unavailable from this device.");
      }
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
      if (current.paused !== input.paused) {
        const thread = input.groupId
          ? await tx.thread.findFirst({
              where: { groupId: input.groupId, spaceId: actor.spaceId, userId: actor.userId },
              select: { id: true, botId: true },
            })
          : await tx.thread.findFirst({
              where: { spaceId: actor.spaceId, userId: actor.userId, botId: { not: null } },
              select: { id: true, botId: true },
            });
        const group = input.groupId
          ? await tx.chatGroup.findUnique({
              where: { id: input.groupId },
              select: { coordinatorBotId: true },
            })
          : null;
        const botId = group?.coordinatorBotId ?? thread?.botId;
        if (thread && botId)
          await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: thread.id,
            botId,
            type: input.paused ? "bot.traffic.paused" : "bot.traffic.resumed",
            payload: {
              scope: input.scope,
              groupId: input.groupId ?? null,
              revision: row.revision,
              actorUserId: actor.userId,
            },
          });
      }
      if (input.paused && !current.paused) {
        const goals = await tx.teamGoal.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            ...(input.groupId ? { groupId: input.groupId } : {}),
          },
          select: { id: true },
        });
        const goalIds = goals.map((goal) => goal.id);
        const deliveries = await tx.botMessageDelivery.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            ...(input.groupId
              ? { OR: [{ sourceGroupId: input.groupId }, { targetGroupId: input.groupId }] }
              : {}),
            delegationId: { not: null },
          },
          select: { id: true, delegationId: true, inboundMessageId: true },
        });
        const wakes = goalIds.length
          ? await tx.botMessageWake.findMany({
              where: {
                goalId: { in: goalIds },
                state: { in: ["pending", "sealed", "retry_wait", "bound"] },
              },
              select: { id: true, runId: true, steeringMessageId: true, deliveryIds: true },
            })
          : [];
        const directRuns = await tx.run.findMany({
          where: {
            delegationId: {
              in: deliveries.flatMap((d) => (d.delegationId ? [d.delegationId] : [])),
            },
            status: { in: ["queued", "peer_ready", "leased", "running"] },
          },
          select: { id: true, status: true },
        });
        const parked = directRuns
          .filter((run) => run.status === "queued" || run.status === "peer_ready")
          .map((run) => run.id);
        if (parked.length)
          await tx.run.updateMany({
            where: { id: { in: parked }, status: { in: ["queued", "peer_ready"] } },
            data: { status: "peer_paused" },
          });
        const affected = [
          ...new Set([
            ...wakes.flatMap((wake) => (wake.runId && !wake.steeringMessageId ? [wake.runId] : [])),
            ...directRuns.map((run) => run.id),
          ]),
        ];
        if (affected.length)
          await tx.run.updateMany({
            where: { id: { in: affected }, status: { in: ["leased", "running"] } },
            data: { cancelRequestedAt: new Date() },
          });
        const queuedWakes = wakes.flatMap((wake) =>
          wake.runId && !wake.steeringMessageId ? [wake.runId] : [],
        );
        if (queuedWakes.length)
          await tx.run.updateMany({
            where: { id: { in: queuedWakes }, status: "queued" },
            data: { cancelRequestedAt: new Date() },
          });
        const pendingWakes = wakes.filter((wake) => !wake.runId).map((wake) => wake.id);
        if (pendingWakes.length)
          await tx.botMessageWake.updateMany({
            where: { id: { in: pendingWakes } },
            data: { state: "paused", nextAttemptAt: null },
          });
        const wakeDeliveries = wakes.flatMap((wake) => wake.deliveryIds);
        const inbound = wakeDeliveries.length
          ? await tx.botMessageDelivery.findMany({
              where: { id: { in: wakeDeliveries } },
              select: { inboundMessageId: true },
            })
          : [];
        const messageIds = [...deliveries, ...inbound].flatMap((delivery) =>
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
        const eligibleGoals: string[] = [];
        for (const goal of goals) {
          const row = await tx.teamGoal.findUnique({
            where: { id: goal.id },
            select: { groupId: true },
          });
          if (
            row &&
            !(await peerTrafficPaused(tx, {
              spaceId: actor.spaceId,
              userId: actor.userId,
              groupId: row.groupId,
            }))
          )
            eligibleGoals.push(goal.id);
        }
        await tx.botMessageWake.updateMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            goalId: { in: eligibleGoals },
            state: "paused",
          },
          data: { state: "pending", nextAttemptAt: null },
        });
        await tx.run.updateMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            goalId: { in: eligibleGoals },
            status: "peer_paused",
            delegationId: { not: null },
          },
          data: { status: "peer_ready" },
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
