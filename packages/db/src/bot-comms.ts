import { createHash, randomUUID } from "node:crypto";
import type { MessageBlock } from "@ardurbot/contracts";
import {
  BOT_MESSAGE_BATCH_MAX_CHARACTERS,
  BOT_MESSAGE_PENDING_MAX,
  canAppendBotMessageToBatch,
} from "@ardurbot/contracts";
import { buildBotMessageWakePrompt } from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class BotInboxFullError extends Error {
  constructor() {
    super("Inbox full");
  }
}

/** Recompute from durable usage rows so a late or revised observation never wakes a bot. */
export async function refreshBotMessageUsageProjectionInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
) {
  const deliveries = await tx.botMessageDelivery.findMany({
    where: { usageRunIds: { has: runId } },
    select: { id: true, usageRunIds: true },
  });
  for (const delivery of deliveries) {
    const usage = await tx.usageRecord.findMany({
      where: { runId: { in: delivery.usageRunIds } },
      select: { inputTokens: true, outputTokens: true, cost: true },
    });
    await tx.botMessageDelivery.update({
      where: { id: delivery.id },
      data: {
        tokens: usage.reduce((total, row) => total + row.inputTokens + row.outputTokens, 0),
        cost:
          usage.length > 0 && usage.every((row) => row.cost !== null)
            ? usage.reduce((total, row) => total + row.cost!, 0)
            : null,
      },
    });
  }
}

/** Fingerprints the recipient's current pin and policy boundary, not the peer's text. */
export async function goalBotAuthorityFingerprint(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string; goalId: string; rootTaskId: string; botId: string },
) {
  const bot = await tx.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
    select: {
      modelPinRevision: true,
      computerId: true,
      runtimeKind: true,
      allowedModelDestinations: true,
    },
  });
  const space = await tx.space.findUnique({
    where: { id: input.spaceId },
    select: { allowedModelDestinations: true },
  });
  const policies = await tx.remoteAuthorityPolicy.findMany({
    where: {
      OR: [
        { layer: "space", subjectId: input.spaceId },
        { layer: "bot", subjectId: input.botId },
      ],
    },
    orderBy: [{ layer: "asc" }, { subjectId: "asc" }],
    select: { layer: true, subjectId: true, scopes: true },
  });
  if (!bot || !space) throw new Error("Recipient authority is unavailable.");
  return createHash("sha256")
    .update(JSON.stringify([input.goalId, input.rootTaskId, input.botId, bot, space, policies]))
    .digest("hex");
}

/** The caller holds the coordinator thread, other threads in ID order, then root. */
export async function appendBotMessageWakeInTransaction(
  tx: Prisma.TransactionClient,
  delivery: {
    id: string;
    spaceId: string;
    userId: string;
    goalId: string | null;
    rootTaskId: string;
    recipientBotId: string;
    recipientThreadId: string;
    authorityFingerprint: string;
  },
  promptCharacters: number,
): Promise<string[]> {
  if (promptCharacters > BOT_MESSAGE_BATCH_MAX_CHARACTERS)
    throw new Error("Message exceeds the batch prompt limit.");
  const outstanding = await tx.botMessageDelivery.count({
    where: {
      spaceId: delivery.spaceId,
      userId: delivery.userId,
      recipientBotId: delivery.recipientBotId,
      state: { in: ["queued", "delivered"] },
      outcome: null,
    },
  });
  if (outstanding > BOT_MESSAGE_PENDING_MAX) throw new BotInboxFullError();
  const key = {
    rootTaskId: delivery.rootTaskId,
    recipientBotId: delivery.recipientBotId,
    recipientThreadId: delivery.recipientThreadId,
    authorityFingerprint: delivery.authorityFingerprint,
  };
  let open = await tx.botMessageWake.findFirst({ where: { ...key, state: "pending" } });
  const queuedRunIds: string[] = [];
  if (
    open &&
    !canAppendBotMessageToBatch(open.deliveryIds.length, open.promptCharacters, promptCharacters)
  ) {
    const runId = await bindBotMessageWakeInTransaction(tx, open.id, true);
    if (runId) queuedRunIds.push(runId);
    open = null;
  }
  if (open) {
    await tx.botMessageWake.update({
      where: { id: open.id },
      data: {
        deliveryIds: { push: delivery.id },
        promptCharacters: { increment: promptCharacters + 2 },
      },
    });
    return queuedRunIds;
  }
  const latest = await tx.botMessageWake.findFirst({
    where: key,
    orderBy: { generation: "desc" },
    select: { generation: true },
  });
  const id = randomUUID();
  const generation = (latest?.generation ?? 0) + 1;
  await tx.botMessageWake.create({
    data: {
      id,
      ...key,
      spaceId: delivery.spaceId,
      userId: delivery.userId,
      goalId: delivery.goalId,
      generation,
      deliveryIds: [delivery.id],
      promptCharacters,
      clientNonce: `peer-wake:${id}:${generation}`,
    },
  });
  return queuedRunIds;
}

async function wakePrompt(tx: Prisma.TransactionClient, deliveryIds: string[]) {
  const deliveries = await tx.botMessageDelivery.findMany({
    where: { id: { in: deliveryIds } },
  });
  const byId = new Map(deliveries.map((row) => [row.id, row]));
  const prompts: string[] = [];
  let lastMessageId: string | null = null;
  for (const id of deliveryIds) {
    const delivery = byId.get(id);
    if (!delivery?.inboundMessageId) throw new Error("Wake has no delivered message.");
    const inbound = await tx.message.findUniqueOrThrow({
      where: { id: delivery.inboundMessageId },
      select: { blocks: true, threadId: true },
    });
    if (inbound.threadId !== delivery.recipientThreadId)
      throw new Error("Wake message has a different recipient thread.");
    const block = (inbound.blocks as MessageBlock[]).find(
      (candidate) => candidate.kind === "bot_message_received" && candidate.deliveryId === id,
    );
    if (block?.kind !== "bot_message_received") throw new Error("Wake message has no receipt.");
    prompts.push(
      buildBotMessageWakePrompt({
        from: { id: delivery.senderBotId, name: block.fromBotName },
        text: block.text,
        intent: block.intent,
      }),
    );
    lastMessageId = delivery.inboundMessageId;
  }
  return { prompt: prompts.join("\n\n"), lastMessageId };
}

async function bindBotMessageWakeInTransaction(
  tx: Prisma.TransactionClient,
  wakeId: string,
  forceQueue = false,
): Promise<string | null> {
  const wake = await tx.botMessageWake.findUniqueOrThrow({ where: { id: wakeId } });
  if (wake.state !== "pending") return null;
  const goal = wake.goalId
    ? await tx.teamGoal.findFirst({
        where: {
          id: wake.goalId,
          rootTaskId: wake.rootTaskId,
          spaceId: wake.spaceId,
          userId: wake.userId,
          status: "running",
        },
      })
    : null;
  const root = await tx.delegationRoot.findUnique({ where: { rootTaskId: wake.rootTaskId } });
  const now = new Date();
  if (
    !goal ||
    !root ||
    goal.untilAt <= now ||
    root.deadlineAt <= now ||
    root.cancelRequestedAt ||
    root.usedTokens >= Math.min(goal.tokenLimit, root.tokenLimit)
  ) {
    await tx.botMessageWake.update({ where: { id: wake.id }, data: { state: "cancelled" } });
    await tx.botMessageDelivery.updateMany({
      where: { id: { in: wake.deliveryIds }, state: { in: ["queued", "delivered"] } },
      data: { state: "expired", failureCode: "goal-unavailable" },
    });
    return null;
  }
  const authorityFingerprint = await goalBotAuthorityFingerprint(tx, {
    spaceId: wake.spaceId,
    userId: wake.userId,
    goalId: goal.id,
    rootTaskId: root.rootTaskId,
    botId: wake.recipientBotId,
  });
  if (authorityFingerprint !== wake.authorityFingerprint) {
    await tx.botMessageWake.update({ where: { id: wake.id }, data: { state: "cancelled" } });
    await tx.botMessageDelivery.updateMany({
      where: { id: { in: wake.deliveryIds }, state: { in: ["queued", "delivered"] } },
      data: { state: "failed", failureCode: "authority-changed" },
    });
    return null;
  }
  const active = await tx.run.findFirst({
    where: {
      spaceId: wake.spaceId,
      userId: wake.userId,
      botId: wake.recipientBotId,
      threadId: wake.recipientThreadId,
      status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
    },
    orderBy: { createdAt: "asc" },
  });
  const incoming =
    active && !forceQueue
      ? await tx.botMessageDelivery.findMany({
          where: { id: { in: wake.deliveryIds } },
          select: { inReplyToDeliveryId: true },
        })
      : [];
  const parents =
    incoming.length === wake.deliveryIds.length && incoming.every((row) => row.inReplyToDeliveryId)
      ? await tx.botMessageDelivery.findMany({
          where: { id: { in: incoming.map((row) => row.inReplyToDeliveryId!) } },
          select: { id: true, sourceRunId: true },
        })
      : [];
  const sameCard = Boolean(
    active &&
      parents.length === incoming.length &&
      parents.every((parent) => parent.sourceRunId === active.id),
  );
  const compatible =
    !forceQueue &&
    active?.status === "running" &&
    active.goalId === goal.id &&
    active.delegationRootTaskId === root.rootTaskId &&
    active.comparisonId === null &&
    active.delegationId === null &&
    active.remoteRootTaskId === null &&
    active.originDeviceGrantId === null &&
    active.remoteDeviceGrantIds.length === 0 &&
    active.trigger !== "user" &&
    sameCard &&
    active.peerAuthorityFingerprint === wake.authorityFingerprint;
  if (active && !compatible && !forceQueue) return null;
  if (
    compatible &&
    (await tx.botMessageWake.findFirst({
      where: { runId: active.id, state: "bound" },
      select: { id: true },
    }))
  )
    return null;
  if (compatible) {
    let steeringMessageId: string | null = null;
    for (const deliveryId of wake.deliveryIds) {
      const delivery = await tx.botMessageDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
        select: { inboundMessageId: true, usageRunIds: true },
      });
      if (!delivery.inboundMessageId) throw new Error("Wake has no inbound message.");
      if (!delivery.usageRunIds.includes(active.id))
        await tx.botMessageDelivery.update({
          where: { id: deliveryId },
          data: { usageRunIds: { push: active.id } },
        });
      const steering = await tx.steeringMessage.create({
        data: {
          messageId: delivery.inboundMessageId,
          botId: wake.recipientBotId,
          userId: wake.userId,
          runId: active.id,
        },
      });
      steeringMessageId ??= steering.id;
    }
    await tx.botMessageWake.update({
      where: { id: wake.id },
      data: { state: "bound", runId: active.id, steeringMessageId },
    });
    return null;
  }
  return createWakeRunInTransaction(tx, wake);
}

async function createWakeRunInTransaction(
  tx: Prisma.TransactionClient,
  wake: {
    id: string;
    spaceId: string;
    userId: string;
    goalId: string | null;
    rootTaskId: string;
    recipientBotId: string;
    recipientThreadId: string;
    deliveryIds: string[];
    clientNonce: string;
  },
) {
  const { prompt, lastMessageId } = await wakePrompt(tx, wake.deliveryIds);
  const task = await tx.task.create({
    data: {
      spaceId: wake.spaceId,
      userId: wake.userId,
      botId: wake.recipientBotId,
      threadId: wake.recipientThreadId,
      prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: wake.spaceId,
      userId: wake.userId,
      botId: wake.recipientBotId,
      threadId: wake.recipientThreadId,
      taskId: task.id,
      status: "queued",
      trigger: "follow_up",
      sourceMessageId: lastMessageId,
      clientNonce: wake.clientNonce,
      goalId: wake.goalId,
      delegationRootTaskId: wake.rootTaskId,
    },
  });
  await tx.botMessageWake.update({
    where: { id: wake.id },
    data: { state: "bound", runId: run.id },
  });
  for (const deliveryId of wake.deliveryIds) {
    const delivery = await tx.botMessageDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { usageRunIds: true },
    });
    if (!delivery.usageRunIds.includes(run.id))
      await tx.botMessageDelivery.update({
        where: { id: deliveryId },
        data: { usageRunIds: { push: run.id } },
      });
  }
  return run.id;
}

/** Replayed safely after commit and by the reconciler. */
export async function dispatchBotMessageWake(prisma: PrismaClient, wakeId: string) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const candidate = await tx.botMessageWake.findUnique({ where: { id: wakeId } });
      if (candidate?.state !== "pending") return null;
      const root = await tx.delegationRoot.findUnique({
        where: { rootTaskId: candidate.rootTaskId },
        select: { coordinatorThreadId: true },
      });
      if (!root) return null;
      for (const threadId of [
        root.coordinatorThreadId,
        ...[candidate.recipientThreadId].filter((id) => id !== root.coordinatorThreadId).sort(),
      ])
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${candidate.rootTaskId} FOR UPDATE`;
      return bindBotMessageWakeInTransaction(tx, wakeId);
    }),
  );
}

/** Finalization calls this while it already holds the thread and root locks. */
export async function settleBotMessageWakesInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  completed: boolean,
): Promise<string | null> {
  const wakes = await tx.botMessageWake.findMany({ where: { runId, state: "bound" } });
  let continuationRunId: string | null = null;
  for (const wake of wakes) {
    const claimed = wake.steeringMessageId
      ? await tx.steeringMessage.findUnique({
          where: { id: wake.steeringMessageId },
          select: { claimedAt: true },
        })
      : null;
    if (completed && (!wake.steeringMessageId || claimed?.claimedAt)) {
      await tx.botMessageWake.update({
        where: { id: wake.id },
        data: { state: "consumed", consumedAt: new Date() },
      });
      await tx.botMessageDelivery.updateMany({
        where: { id: { in: wake.deliveryIds }, outcome: null },
        data: { outcome: "consumed" },
      });
      continue;
    }
    if (wake.steeringMessageId)
      await tx.steeringMessage.deleteMany({
        where: {
          messageId: {
            in: (
              await tx.botMessageDelivery.findMany({
                where: { id: { in: wake.deliveryIds } },
                select: { inboundMessageId: true },
              })
            ).flatMap((delivery) => (delivery.inboundMessageId ? [delivery.inboundMessageId] : [])),
          },
          runId,
        },
      });
    await tx.botMessageDelivery.updateMany({
      where: { id: { in: wake.deliveryIds }, state: "delivered" },
      data: { failureCode: "read-unconfirmed" },
    });
    // A newer pending generation may already exist. In that case the sealed
    // batch stays bound while it moves to the new continuation, preserving the
    // one-pending-batch constraint and the newer messages' generation.
    const newerPending = await tx.botMessageWake.findFirst({
      where: {
        rootTaskId: wake.rootTaskId,
        recipientBotId: wake.recipientBotId,
        recipientThreadId: wake.recipientThreadId,
        authorityFingerprint: wake.authorityFingerprint,
        state: "pending",
      },
      select: { id: true },
    });
    if (!newerPending)
      await tx.botMessageWake.update({
        where: { id: wake.id },
        data: { state: "pending", runId: null, steeringMessageId: null },
      });
    const nextGeneration = wake.generation + 1;
    const retry = {
      ...wake,
      clientNonce: `peer-wake:${wake.id}:${nextGeneration}`,
    };
    const nextRunId = await createWakeRunInTransaction(tx, retry);
    await tx.botMessageWake.update({
      where: { id: wake.id },
      data: {
        generation: nextGeneration,
        clientNonce: retry.clientNonce,
        runId: nextRunId,
        steeringMessageId: null,
      },
    });
    continuationRunId ??= nextRunId;
  }
  return continuationRunId;
}
