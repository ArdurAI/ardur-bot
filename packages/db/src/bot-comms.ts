import { createHash, randomUUID } from "node:crypto";
import type { MessageBlock } from "@ardurbot/contracts";
import {
  BOT_MESSAGE_BATCH_MAX_CHARACTERS,
  BOT_MESSAGE_PENDING_MAX,
  canAppendBotMessageToBatch,
} from "@ardurbot/contracts";
import { buildBotMessageWakePrompt } from "@ardurbot/core";
import { lockPeerTrafficPolicy, peerTrafficPaused } from "./bot-comms-policy.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { withTransactionRetry } from "./transaction-retry.js";

const RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
type ThreadCursor = { threadId: string; seq: number };

/** Completion orchestration never interpolates the sender's editable display name. */
export function buildCompletionReviewPrompt(body: string) {
  return `Review the completed assignment and decide the next step for this goal.\n\n${body}`;
}

async function projectDeliveryState(
  tx: Prisma.TransactionClient,
  deliveryId: string,
  state: "read" | "expired" | "failed" | null,
): Promise<ThreadCursor[]> {
  const delivery = await tx.botMessageDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
  const cursors: ThreadCursor[] = [];
  for (const messageId of [delivery.outboundMessageId, delivery.inboundMessageId]) {
    if (!messageId) continue;
    const message = await tx.message.findUnique({ where: { id: messageId } });
    if (!message) continue;
    if (
      !(message.blocks as MessageBlock[]).some(
        (block) =>
          (block.kind === "bot_message_sent" || block.kind === "bot_message_received") &&
          block.deliveryId === deliveryId &&
          (state !== null || block.queuedForBusy),
      )
    )
      continue;
    const blocks = (message.blocks as MessageBlock[]).map((block) =>
      (block.kind === "bot_message_sent" || block.kind === "bot_message_received") &&
      block.deliveryId === deliveryId
        ? { ...block, ...(state === null ? {} : { deliveryState: state }), queuedForBusy: false }
        : block,
    );
    await tx.message.update({ where: { id: messageId }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: delivery.spaceId,
      threadId: message.threadId,
      botId:
        message.threadId === delivery.senderThreadId
          ? delivery.senderBotId
          : delivery.recipientBotId,
      type: "thread.message.updated",
      payload: { messageId, blocks },
    });
    cursors.push({ threadId: message.threadId, seq: event.seq });
  }
  return cursors;
}

export type BotMessageInputAck = {
  runId: string;
  leaseFence: number;
  deliveryIds: string[];
  mode: "initial" | "steering";
};

/** A runtime receipt is valid only for content owned by its current run and lease. */
export async function acknowledgeBotMessageInput(
  prisma: PrismaClient,
  input: BotMessageInputAck,
  acceptedDeliveryIds: readonly string[],
): Promise<{
  changed: number;
  refused: "stale-fence" | "foreign-delivery" | null;
  updatedThreads: ThreadCursor[];
}> {
  if (input.mode !== "initial" && input.mode !== "steering")
    throw new Error("Unsupported bot message input acknowledgement mode.");
  const ids = [...new Set(input.deliveryIds)];
  if (ids.length === 0) return { changed: 0, refused: null, updatedThreads: [] };
  // A turn can contain one eight-delivery wake and up to twenty quiet entries.
  if (ids.length > 32) throw new Error("Too many bot message receipt IDs.");
  if (ids.some((id) => !acceptedDeliveryIds.includes(id)))
    return { changed: 0, refused: "foreign-delivery", updatedThreads: [] };
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({
        where: { id: input.runId },
        select: {
          id: true,
          status: true,
          leaseFence: true,
          botId: true,
          threadId: true,
          goalId: true,
          delegationRootTaskId: true,
          delegationId: true,
        },
      });
      if (run?.status !== "running" || run.leaseFence !== input.leaseFence)
        return { changed: 0, refused: "stale-fence" as const, updatedThreads: [] };
      const wakes = await tx.botMessageWake.findMany({
        where: { runId: run.id, state: "bound", deliveryIds: { hasSome: ids } },
        select: { deliveryIds: true, steeringMessageId: true },
      });
      const claimed = wakes.flatMap((wake) =>
        wake.steeringMessageId ? [wake.steeringMessageId] : [],
      );
      const steering = claimed.length
        ? await tx.steeringMessage.findMany({
            where: { id: { in: claimed }, runId: run.id, claimedAt: { not: null } },
            select: { id: true },
          })
        : [];
      const claimedIds = new Set(steering.map((item) => item.id));
      const deliveries = await tx.botMessageDelivery.findMany({ where: { id: { in: ids } } });
      if (deliveries.length !== ids.length)
        return { changed: 0, refused: "foreign-delivery" as const, updatedThreads: [] };
      for (const delivery of deliveries) {
        const sameRecipient =
          delivery.recipientBotId === run.botId &&
          delivery.recipientThreadId === run.threadId &&
          delivery.goalId === run.goalId &&
          delivery.rootTaskId === run.delegationRootTaskId;
        const inWake = wakes.some(
          (wake) =>
            wake.deliveryIds.includes(delivery.id) &&
            (input.mode === "steering"
              ? Boolean(wake.steeringMessageId && claimedIds.has(wake.steeringMessageId))
              : !wake.steeringMessageId),
        );
        const delegated =
          input.mode === "initial" &&
          Boolean(delivery.delegationId && delivery.delegationId === run.delegationId);
        const quiet =
          input.mode === "initial" &&
          (delivery.intent === "status" ||
            delivery.intent === "fyi" ||
            (delivery.intent === "result" && !delivery.inReplyToDeliveryId)) &&
          delivery.outcome === null &&
          delivery.quietClaimRunId === run.id &&
          delivery.quietClaimLeaseFence === input.leaseFence;
        if (!sameRecipient || !(inWake || delegated || quiet))
          return { changed: 0, refused: "foreign-delivery" as const, updatedThreads: [] };
      }
      const root = run.delegationRootTaskId
        ? await tx.delegationRoot.findUnique({
            where: { rootTaskId: run.delegationRootTaskId },
            select: { coordinatorThreadId: true },
          })
        : null;
      for (const threadId of [
        ...(root ? [root.coordinatorThreadId] : []),
        ...[run.threadId].filter((id) => id !== root?.coordinatorThreadId).sort(),
      ])
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      if (run.delegationRootTaskId)
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${run.delegationRootTaskId} FOR UPDATE`;
      // Updating the run row serializes this receipt with lease transfer and finalization.
      const fence = await tx.run.updateMany({
        where: { id: run.id, status: "running", leaseFence: input.leaseFence },
        data: { leaseFence: input.leaseFence },
      });
      if (!fence.count) return { changed: 0, refused: "stale-fence" as const, updatedThreads: [] };
      let changed = 0;
      const updatedThreads: ThreadCursor[] = [];
      for (const delivery of deliveries) {
        const result = await tx.botMessageDelivery.updateMany({
          where: { id: delivery.id, state: "delivered" },
          data: { state: "read", readAt: new Date(), failureCode: null },
        });
        if (result.count) {
          changed++;
          updatedThreads.push(...(await projectDeliveryState(tx, delivery.id, "read")));
        }
        if (
          delivery.quietClaimRunId === run.id &&
          delivery.quietClaimLeaseFence === input.leaseFence
        )
          await tx.botMessageDelivery.updateMany({
            where: {
              id: delivery.id,
              outcome: null,
              quietClaimRunId: run.id,
              quietClaimLeaseFence: input.leaseFence,
            },
            data: { outcome: "consumed", quietClaimRunId: null, quietClaimLeaseFence: null },
          });
      }
      return { changed, refused: null, updatedThreads };
    }),
  );
}

/** Unsupported runtimes keep the delivery receipt at Delivered with an explicit diagnostic. */
export async function noteBotMessageReadUnconfirmed(
  prisma: PrismaClient,
  input: { runId: string; leaseFence: number; deliveryIds: string[] },
) {
  if (input.deliveryIds.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    const run = await tx.run.findFirst({
      where: { id: input.runId, status: "running", leaseFence: input.leaseFence },
      select: { botId: true, threadId: true, goalId: true, delegationRootTaskId: true },
    });
    if (!run) return 0;
    const changed = await tx.botMessageDelivery.updateMany({
      where: {
        id: { in: input.deliveryIds },
        recipientBotId: run.botId,
        recipientThreadId: run.threadId,
        goalId: run.goalId,
        rootTaskId: run.delegationRootTaskId ?? "",
        state: "delivered",
      },
      data: { failureCode: "read-unconfirmed" },
    });
    return changed.count;
  });
}

async function finishWake(
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
  },
  state: "cancelled" | "failed",
  failureCode: string,
  notice: boolean,
): Promise<ThreadCursor[]> {
  await tx.botMessageWake.update({ where: { id: wake.id }, data: { state, nextAttemptAt: null } });
  const updatedThreads: ThreadCursor[] = [];
  for (const id of wake.deliveryIds) {
    const changed = await tx.botMessageDelivery.updateMany({
      where: { id, state: { in: ["queued", "delivered", "read"] }, outcome: null },
      data: { state: "failed", failureCode, outcome: "failed" },
    });
    if (changed.count) updatedThreads.push(...(await projectDeliveryState(tx, id, "failed")));
  }
  if (!notice) return updatedThreads;
  const root = await tx.delegationRoot.findUnique({
    where: { rootTaskId: wake.rootTaskId },
    select: { coordinatorThreadId: true, coordinatorBotId: true },
  });
  const threadId = root?.coordinatorThreadId ?? wake.recipientThreadId;
  const thread = await tx.thread.findUnique({ where: { id: threadId }, select: { id: true } });
  if (!thread) return updatedThreads;
  const nonce = `peer-wake-failure:${wake.id}`;
  const existing = await tx.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce: nonce } },
    select: { id: true },
  });
  if (existing) return updatedThreads;
  const blocks: MessageBlock[] = [
    {
      kind: "text",
      text: "A team reply could not be delivered. Review the goal and retry the request if needed.",
    },
  ];
  const message = await createThreadMessageInTransaction(tx, {
    threadId,
    role: "bot",
    botId: root?.coordinatorBotId ?? wake.recipientBotId,
    blocks,
    clientNonce: nonce,
    markUnread: false,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: wake.spaceId,
    threadId,
    botId: root?.coordinatorBotId ?? wake.recipientBotId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "bot", blocks },
  });
  updatedThreads.push({ threadId, seq: event.seq });
  return updatedThreads;
}

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

async function currentCoordinatorGroup(
  tx: Prisma.TransactionClient,
  wake: { spaceId: string; userId: string; recipientBotId: string },
  goal: { groupId: string; coordinatorBotId: string },
) {
  if (wake.recipientBotId !== goal.coordinatorBotId) return false;
  const group = await tx.chatGroup.findFirst({
    where: {
      id: goal.groupId,
      spaceId: wake.spaceId,
      userId: wake.userId,
      archivedAt: null,
      coordinatorBotId: goal.coordinatorBotId,
      members: { some: { botId: goal.coordinatorBotId, bot: { archivedAt: null } } },
    },
    select: { id: true },
  });
  return Boolean(group);
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
  deferAdmission = false,
): Promise<string[]> {
  if (promptCharacters > BOT_MESSAGE_BATCH_MAX_CHARACTERS && !deferAdmission)
    throw new Error("Message exceeds the batch prompt limit.");
  const outstanding = await tx.botMessageDelivery.count({
    where: {
      spaceId: delivery.spaceId,
      userId: delivery.userId,
      recipientBotId: delivery.recipientBotId,
      state: { in: ["queued", "delivered", "read"] },
      outcome: null,
      expiresAt: { gt: new Date() },
    },
  });
  const admissionProblem =
    promptCharacters > BOT_MESSAGE_BATCH_MAX_CHARACTERS
      ? "prompt-too-large"
      : outstanding > BOT_MESSAGE_PENDING_MAX
        ? "inbox-full"
        : null;
  if (admissionProblem && !deferAdmission) throw new BotInboxFullError();
  if (admissionProblem)
    await tx.botMessageDelivery.update({
      where: { id: delivery.id },
      data: { failureCode: admissionProblem },
    });
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
    (admissionProblem ||
      !canAppendBotMessageToBatch(open.deliveryIds.length, open.promptCharacters, promptCharacters))
  ) {
    if (!admissionProblem) {
      const { runId } = await bindBotMessageWakeInTransaction(tx, open.id);
      if (runId) queuedRunIds.push(runId);
    }
    const sealed = await tx.botMessageWake.findUniqueOrThrow({ where: { id: open.id } });
    if (sealed.state === "pending")
      await tx.botMessageWake.update({ where: { id: open.id }, data: { state: "sealed" } });
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
      nextAttemptAt: admissionProblem ? new Date(Date.now() + RETRY_DELAYS_MS[0]) : null,
    },
  });
  return queuedRunIds;
}

/** Recover a delivery committed by an older version before wake rows existed. */
export async function backfillAutomaticBotMessageWake(prisma: PrismaClient, deliveryId: string) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const delivery = await tx.botMessageDelivery.findUnique({ where: { id: deliveryId } });
      if (!delivery?.idempotencyKey.startsWith("auto-result:")) return null;
      const root = await tx.delegationRoot.findUnique({
        where: { rootTaskId: delivery.rootTaskId },
        select: { coordinatorThreadId: true },
      });
      if (!root) return null;
      for (const threadId of [
        root.coordinatorThreadId,
        ...[delivery.recipientThreadId].filter((id) => id !== root.coordinatorThreadId).sort(),
      ])
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${delivery.rootTaskId} FOR UPDATE`;
      const existing = await tx.botMessageWake.findFirst({
        where: { deliveryIds: { has: delivery.id } },
        select: { id: true, state: true },
      });
      if (existing) {
        if (delivery.sourceDelegationId)
          await tx.delegation.updateMany({
            where: { id: delivery.sourceDelegationId, coordinatorWokenAt: null },
            data: { coordinatorWokenAt: new Date() },
          });
        return ["pending", "sealed", "retry_wait"].includes(existing.state) ? existing.id : null;
      }
      if (!delivery.inboundMessageId) return null;
      const receipt = await tx.message.findUnique({
        where: { id: delivery.inboundMessageId },
        select: { blocks: true },
      });
      const block = (receipt?.blocks as MessageBlock[] | undefined)?.find(
        (candidate) => candidate.kind === "bot_message_received",
      );
      if (block?.kind !== "bot_message_received") return null;
      const prompt = buildCompletionReviewPrompt(
        buildBotMessageWakePrompt({
          from: { id: delivery.senderBotId, name: block.fromBotName },
          text: block.text,
          intent: block.intent,
        }),
      );
      await appendBotMessageWakeInTransaction(tx, delivery, prompt.length, true);
      if (delivery.sourceDelegationId)
        await tx.delegation.updateMany({
          where: { id: delivery.sourceDelegationId, coordinatorWokenAt: null },
          data: { coordinatorWokenAt: new Date() },
        });
      const wake = await tx.botMessageWake.findFirst({
        where: { deliveryIds: { has: delivery.id } },
        select: { id: true },
      });
      return wake?.id ?? null;
    }),
  );
}

async function wakePrompt(tx: Prisma.TransactionClient, deliveryIds: string[], now: Date) {
  const deliveries = await tx.botMessageDelivery.findMany({
    where: { id: { in: deliveryIds } },
  });
  const byId = new Map(deliveries.map((row) => [row.id, row]));
  const prompts: string[] = [];
  const liveIds: string[] = [];
  const updatedThreads: ThreadCursor[] = [];
  let lastMessageId: string | null = null;
  for (const id of deliveryIds) {
    const delivery = byId.get(id);
    if (
      delivery &&
      (delivery.expiresAt <= now || !["queued", "delivered", "read"].includes(delivery.state))
    ) {
      if (delivery.expiresAt <= now && ["queued", "delivered", "read"].includes(delivery.state)) {
        await tx.botMessageDelivery.update({
          where: { id },
          data: { state: "expired", outcome: "expired" },
        });
        updatedThreads.push(...(await projectDeliveryState(tx, id, "expired")));
      }
      continue;
    }
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
    const body = buildBotMessageWakePrompt({
      from: { id: delivery.senderBotId, name: block.fromBotName },
      text: block.text,
      intent: block.intent,
    });
    prompts.push(
      delivery.idempotencyKey.startsWith("auto-result:") ? buildCompletionReviewPrompt(body) : body,
    );
    liveIds.push(id);
    lastMessageId = delivery.inboundMessageId;
  }
  return { prompt: prompts.join("\n\n"), lastMessageId, liveIds, updatedThreads };
}

async function bindBotMessageWakeInTransaction(
  tx: Prisma.TransactionClient,
  wakeId: string,
): Promise<{ runId: string | null; updatedThreads: ThreadCursor[] }> {
  const updatedThreads: ThreadCursor[] = [];
  let wake = await tx.botMessageWake.findUniqueOrThrow({ where: { id: wakeId } });
  if (
    !["pending", "sealed", "retry_wait"].includes(wake.state) ||
    (wake.nextAttemptAt && wake.nextAttemptAt > new Date())
  )
    return { runId: null, updatedThreads };
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
    await peerTrafficPaused(tx, {
      spaceId: wake.spaceId,
      userId: wake.userId,
      groupId: goal?.groupId,
    })
  )
    return { runId: null, updatedThreads };
  if (
    !goal ||
    !root ||
    goal.untilAt <= now ||
    root.deadlineAt <= now ||
    root.cancelRequestedAt ||
    root.usedTokens >= Math.min(goal.tokenLimit, root.tokenLimit)
  ) {
    updatedThreads.push(...(await finishWake(tx, wake, "cancelled", "goal-unavailable", true)));
    return { runId: null, updatedThreads };
  }
  const thread = await tx.thread.findUnique({
    where: { id: wake.recipientThreadId },
    select: { id: true, botId: true, groupId: true },
  });
  if (!thread || thread.id !== goal.threadId || thread.groupId !== goal.groupId) {
    updatedThreads.push(...(await finishWake(tx, wake, "cancelled", "thread-unavailable", true)));
    return { runId: null, updatedThreads };
  }
  const recipient = await tx.bot.findFirst({
    where: {
      id: wake.recipientBotId,
      spaceId: wake.spaceId,
      userId: wake.userId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!recipient) {
    updatedThreads.push(
      ...(await finishWake(tx, wake, "cancelled", "recipient-unavailable", true)),
    );
    return { runId: null, updatedThreads };
  }
  if (!(await currentCoordinatorGroup(tx, wake, goal))) {
    updatedThreads.push(...(await finishWake(tx, wake, "cancelled", "group-unavailable", true)));
    return { runId: null, updatedThreads };
  }
  const authorityFingerprint = await goalBotAuthorityFingerprint(tx, {
    spaceId: wake.spaceId,
    userId: wake.userId,
    goalId: goal.id,
    rootTaskId: root.rootTaskId,
    botId: wake.recipientBotId,
  });
  if (authorityFingerprint !== wake.authorityFingerprint) {
    updatedThreads.push(...(await finishWake(tx, wake, "cancelled", "authority-changed", true)));
    return { runId: null, updatedThreads };
  }
  const deferred = await tx.botMessageDelivery.findMany({
    where: {
      id: { in: wake.deliveryIds },
      failureCode: { in: ["inbox-full", "prompt-too-large"] },
    },
    select: { failureCode: true },
  });
  if (deferred.some((row) => row.failureCode === "prompt-too-large")) {
    updatedThreads.push(...(await finishWake(tx, wake, "failed", "prompt-too-large", true)));
    return { runId: null, updatedThreads };
  }
  if (deferred.length) {
    const outstanding = await tx.botMessageDelivery.count({
      where: {
        spaceId: wake.spaceId,
        userId: wake.userId,
        recipientBotId: wake.recipientBotId,
        state: { in: ["queued", "delivered", "read"] },
        outcome: null,
        expiresAt: { gt: now },
      },
    });
    if (outstanding > BOT_MESSAGE_PENDING_MAX) {
      await tx.botMessageWake.update({
        where: { id: wake.id },
        data: { nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_MS[0]) },
      });
      return { runId: null, updatedThreads };
    }
    await tx.botMessageDelivery.updateMany({
      where: { id: { in: wake.deliveryIds }, failureCode: "inbox-full" },
      data: { failureCode: null },
    });
    await tx.botMessageWake.update({ where: { id: wake.id }, data: { nextAttemptAt: null } });
  }
  const prepared = await wakePrompt(tx, wake.deliveryIds, now);
  updatedThreads.push(...prepared.updatedThreads);
  if (prepared.liveIds.length !== wake.deliveryIds.length) {
    if (prepared.liveIds.length === 0) {
      await tx.botMessageWake.update({
        where: { id: wake.id },
        data: { state: "cancelled", deliveryIds: [], promptCharacters: 0 },
      });
      return { runId: null, updatedThreads };
    }
    wake = await tx.botMessageWake.update({
      where: { id: wake.id },
      data: { deliveryIds: prepared.liveIds, promptCharacters: prepared.prompt.length },
    });
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
  const incoming = active
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
  if (active && !compatible) return { runId: null, updatedThreads };
  if (
    compatible &&
    (await tx.botMessageWake.findFirst({
      where: { runId: active.id, state: "bound" },
      select: { id: true },
    }))
  )
    return { runId: null, updatedThreads };
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
    return { runId: null, updatedThreads };
  }
  return { runId: await createWakeRunInTransaction(tx, wake, updatedThreads), updatedThreads };
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
  updatedThreads: ThreadCursor[],
) {
  const {
    prompt,
    lastMessageId,
    liveIds,
    updatedThreads: expiredThreads,
  } = await wakePrompt(tx, wake.deliveryIds, new Date());
  updatedThreads.push(...expiredThreads);
  if (liveIds.length === 0) {
    await tx.botMessageWake.update({
      where: { id: wake.id },
      data: { state: "cancelled", deliveryIds: [], promptCharacters: 0 },
    });
    return null;
  }
  if (liveIds.length !== wake.deliveryIds.length)
    await tx.botMessageWake.update({
      where: { id: wake.id },
      data: { deliveryIds: liveIds, promptCharacters: prompt.length },
    });
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
  for (const deliveryId of liveIds) {
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
      if (!candidate || !["pending", "sealed", "retry_wait"].includes(candidate.state))
        return { runId: null, updatedThreads: [] };
      if (candidate.nextAttemptAt && candidate.nextAttemptAt > new Date())
        return { runId: null, updatedThreads: [] };
      const root = await tx.delegationRoot.findUnique({
        where: { rootTaskId: candidate.rootTaskId },
        select: { coordinatorThreadId: true },
      });
      if (!root) {
        const updatedThreads = await finishWake(
          tx,
          candidate,
          "cancelled",
          "goal-unavailable",
          true,
        );
        return { runId: null, updatedThreads };
      }
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

/** Quiet receipts do not have a wake; expiry must still release inbox capacity. */
export async function expireQuietBotMessages(prisma: PrismaClient, now = new Date(), limit = 100) {
  const stale = await prisma.botMessageDelivery.findMany({
    where: {
      state: { in: ["queued", "delivered", "read"] },
      outcome: null,
      quietClaimRunId: null,
      expiresAt: { lte: now },
      OR: [{ intent: { in: ["status", "fyi"] } }, { intent: "result", inReplyToDeliveryId: null }],
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  for (const row of stale)
    await prisma.$transaction(async (tx) => {
      const changed = await tx.botMessageDelivery.updateMany({
        where: {
          id: row.id,
          state: { in: ["queued", "delivered", "read"] },
          outcome: null,
          quietClaimRunId: null,
          expiresAt: { lte: now },
        },
        data: { state: "expired", outcome: "expired" },
      });
      if (changed.count) await projectDeliveryState(tx, row.id, "expired");
    });
  return stale.length;
}

/** Only the peer delivery expires; ordinary effect approval lifetimes are unchanged. */
export async function expireHeldBotMessages(prisma: PrismaClient, now = new Date(), limit = 100) {
  const stale = await prisma.botMessageDelivery.findMany({
    where: { state: "held", expiresAt: { lte: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, senderThreadId: true, recipientThreadId: true },
  });
  let expired = 0;
  for (const row of stale)
    await prisma.$transaction(async (tx) => {
      for (const threadId of [...new Set([row.senderThreadId, row.recipientThreadId])].sort())
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      const delivery = await tx.botMessageDelivery.findUnique({ where: { id: row.id } });
      if (delivery?.state !== "held" || delivery.expiresAt > now) return;
      await tx.botMessageDelivery.update({
        where: { id: delivery.id },
        data: { state: "expired", outcome: "expired" },
      });
      await projectDeliveryState(tx, delivery.id, "expired");
      if (delivery.approvalEffectId)
        await tx.externalEffect.updateMany({
          where: { id: delivery.approvalEffectId, status: "intended" },
          data: { status: "failed", result: { reason: "peer-delivery-expired" } },
        });
      if (delivery.delegationId) {
        const run = await tx.run.findFirst({
          where: { delegationId: delivery.delegationId, status: "waiting_input" },
          select: { id: true, taskId: true },
        });
        if (run) {
          await tx.run.update({
            where: { id: run.id },
            data: { status: "cancelled", completedAt: now },
          });
          await tx.task.update({ where: { id: run.taskId }, data: { status: "cancelled" } });
          const ask = await tx.message.findUnique({
            where: {
              threadId_clientNonce: {
                threadId: delivery.senderThreadId,
                clientNonce: `peer-hold:${delivery.idempotencyKey}`,
              },
            },
          });
          if (ask) {
            const blocks = (ask.blocks as MessageBlock[]).map((block) =>
              block.kind === "ask" && block.approvalEffectId === delivery.approvalEffectId
                ? { ...block, status: "answered" as const, answer: "expired" }
                : block,
            );
            await tx.message.update({ where: { id: ask.id }, data: { blocks } });
            await appendEventInTransaction(tx, {
              spaceId: delivery.spaceId,
              threadId: ask.threadId,
              botId: delivery.senderBotId,
              type: "thread.message.updated",
              payload: { messageId: ask.id, role: "bot", blocks },
            });
          }
        }
      }
      expired++;
    });
  return expired;
}

/** Return only quiet deliveries claimed by the current run attempt. */
export async function claimQuietBotMessages(
  prisma: PrismaClient,
  input: { runId: string; leaseOwner: string; leaseFence: number; deliveryIds: string[] },
) {
  if (input.deliveryIds.length === 0) return [];
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const claimant = await tx.run.findUnique({
        where: { id: input.runId },
        select: { spaceId: true, userId: true },
      });
      if (!claimant) throw new Error("Quiet delivery claim lost its run lease.");
      await lockPeerTrafficPolicy(tx, claimant);
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${input.runId} FOR UPDATE`;
      const run = await tx.run.findFirst({
        where: {
          id: input.runId,
          status: "running",
          leaseOwner: input.leaseOwner,
          leaseFence: input.leaseFence,
          leaseExpiresAt: { gt: new Date() },
        },
        select: { id: true, spaceId: true, userId: true, botId: true, threadId: true },
      });
      if (!run) throw new Error("Quiet delivery claim lost its run lease.");
      const claimedIds: string[] = [];
      for (const id of input.deliveryIds) {
        const delivery = await tx.botMessageDelivery.findFirst({
          where: { id, spaceId: run.spaceId, userId: run.userId },
          select: { goalId: true, sourceGroupId: true },
        });
        if (!delivery) continue;
        const goal =
          delivery.goalId && !delivery.sourceGroupId
            ? await tx.teamGoal.findUnique({
                where: { id: delivery.goalId },
                select: { groupId: true },
              })
            : null;
        if (
          await peerTrafficPaused(tx, {
            ...claimant,
            groupId: delivery.sourceGroupId ?? goal?.groupId,
          })
        )
          continue;
        const claimed = await tx.botMessageDelivery.updateMany({
          where: {
            id,
            spaceId: run.spaceId,
            userId: run.userId,
            recipientBotId: run.botId,
            recipientThreadId: run.threadId,
            state: { in: ["delivered", "read"] },
            outcome: null,
            expiresAt: { gt: new Date() },
            OR: [
              { quietClaimRunId: null },
              { quietClaimRunId: run.id, quietClaimLeaseFence: { lte: input.leaseFence } },
            ],
          },
          data: { quietClaimRunId: run.id, quietClaimLeaseFence: input.leaseFence },
        });
        if (claimed.count === 1) claimedIds.push(id);
      }
      return claimedIds;
    }),
  );
}

export async function releaseQuietBotMessageClaims(
  prisma: PrismaClient,
  runId: string,
  leaseFence: number,
) {
  await prisma.botMessageDelivery.updateMany({
    where: { quietClaimRunId: runId, quietClaimLeaseFence: leaseFence, outcome: null },
    data: { quietClaimRunId: null, quietClaimLeaseFence: null },
  });
}

/** Native turns consume claimed quiet context on completion; failed turns release it. */
export async function settleQuietBotMessageClaimsInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  leaseFence: number,
  completed: boolean,
) {
  const where = { quietClaimRunId: runId, quietClaimLeaseFence: leaseFence, outcome: null };
  if (!completed) {
    await tx.botMessageDelivery.updateMany({
      where,
      data: { quietClaimRunId: null, quietClaimLeaseFence: null },
    });
    return [];
  }
  const claims = await tx.botMessageDelivery.findMany({ where, select: { id: true } });
  const updatedThreads: ThreadCursor[] = [];
  for (const claim of claims) {
    const settled = await tx.botMessageDelivery.updateMany({
      where: { ...where, id: claim.id },
      data: { outcome: "consumed", quietClaimRunId: null, quietClaimLeaseFence: null },
    });
    if (settled.count) updatedThreads.push(...(await projectDeliveryState(tx, claim.id, null)));
  }
  return updatedThreads;
}

export async function reconcileQuietBotMessageClaims(prisma: PrismaClient, limit = 100) {
  const now = new Date();
  const claims = await prisma.$queryRaw<
    { id: string; quietClaimRunId: string; quietClaimLeaseFence: number | null }[]
  >`SELECT d.id, d."quietClaimRunId", d."quietClaimLeaseFence"
    FROM bot_message_deliveries d
    LEFT JOIN runs r ON r.id = d."quietClaimRunId"
    WHERE d."quietClaimRunId" IS NOT NULL AND d.outcome IS NULL
      AND (r.id IS NULL OR r.status <> 'running'
        OR r."leaseFence" IS DISTINCT FROM d."quietClaimLeaseFence"
        OR r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt" <= ${now})
    ORDER BY d."createdAt" ASC, d.id ASC
    LIMIT ${limit}`;
  for (const claim of claims) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${claim.quietClaimRunId} FOR UPDATE`;
      const run = await tx.run.findUnique({
        where: { id: claim.quietClaimRunId },
        select: { status: true, leaseFence: true, leaseExpiresAt: true },
      });
      if (
        run?.status === "running" &&
        run.leaseFence === claim.quietClaimLeaseFence &&
        run.leaseExpiresAt &&
        run.leaseExpiresAt > new Date()
      )
        return;
      await tx.botMessageDelivery.updateMany({
        where: {
          id: claim.id,
          quietClaimRunId: claim.quietClaimRunId,
          quietClaimLeaseFence: claim.quietClaimLeaseFence,
          outcome: null,
        },
        data: { quietClaimRunId: null, quietClaimLeaseFence: null },
      });
    });
  }
  return claims.length;
}

/** Recheck a leased wake before any runtime input is assembled or executed. */
export async function refreshBoundBotMessageWakeRun(
  prisma: PrismaClient,
  input: { runId: string; leaseOwner: string; leaseFence: number },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const candidate = await tx.botMessageWake.findFirst({
        where: { runId: input.runId, state: "bound" },
      });
      if (!candidate) return true;
      const root = await tx.delegationRoot.findUnique({
        where: { rootTaskId: candidate.rootTaskId },
        select: { coordinatorThreadId: true },
      });
      if (!root) {
        const run = await tx.run.findFirst({
          where: {
            id: input.runId,
            leaseOwner: input.leaseOwner,
            leaseFence: input.leaseFence,
            status: "leased",
          },
          select: { id: true, taskId: true },
        });
        if (run) {
          await finishWake(tx, candidate, "cancelled", "goal-unavailable", true);
          await tx.run.update({
            where: { id: run.id },
            data: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null },
          });
          await tx.task.update({ where: { id: run.taskId }, data: { status: "cancelled" } });
        }
        return false;
      }
      for (const threadId of [
        root.coordinatorThreadId,
        ...[candidate.recipientThreadId].filter((id) => id !== root.coordinatorThreadId).sort(),
      ])
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${candidate.rootTaskId} FOR UPDATE`;
      const run = await tx.run.findFirst({
        where: {
          id: input.runId,
          leaseOwner: input.leaseOwner,
          leaseFence: input.leaseFence,
          status: "leased",
        },
        select: { id: true, taskId: true },
      });
      if (!run) return false;
      const wake = await tx.botMessageWake.findUniqueOrThrow({ where: { id: candidate.id } });
      if (wake.state !== "bound" || wake.runId !== run.id) return false;
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
      if (
        goal &&
        (await peerTrafficPaused(tx, {
          spaceId: wake.spaceId,
          userId: wake.userId,
          groupId: goal.groupId,
        }))
      ) {
        await tx.run.updateMany({
          where: { id: run.id, cancelRequestedAt: null },
          data: { cancelRequestedAt: new Date() },
        });
        return false;
      }
      if (!goal || !(await currentCoordinatorGroup(tx, wake, goal))) {
        await finishWake(tx, wake, "cancelled", "group-unavailable", true);
        await tx.run.update({
          where: { id: run.id },
          data: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null },
        });
        await tx.task.update({ where: { id: run.taskId }, data: { status: "cancelled" } });
        return false;
      }
      const prepared = await wakePrompt(tx, wake.deliveryIds, new Date());
      if (prepared.liveIds.length === wake.deliveryIds.length) return true;
      if (prepared.liveIds.length === 0) {
        await tx.botMessageWake.update({
          where: { id: wake.id },
          data: { state: "cancelled", deliveryIds: [], promptCharacters: 0 },
        });
        await tx.run.update({
          where: { id: run.id },
          data: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null },
        });
        await tx.task.update({ where: { id: run.taskId }, data: { status: "cancelled" } });
        return false;
      }
      await tx.botMessageWake.update({
        where: { id: wake.id },
        data: { deliveryIds: prepared.liveIds, promptCharacters: prepared.prompt.length },
      });
      await tx.task.update({ where: { id: run.taskId }, data: { prompt: prepared.prompt } });
      await tx.run.update({
        where: { id: run.id },
        data: { sourceMessageId: prepared.lastMessageId },
      });
      return true;
    }),
  );
}

/** Finalization calls this while it already holds the thread and root locks. */
export async function settleBotMessageWakesInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  completed: boolean,
  runtimeProblemCode?: string,
): Promise<{ continuationRunId: string | null; updatedThreads: ThreadCursor[] }> {
  const wakes = await tx.botMessageWake.findMany({ where: { runId, state: "bound" } });
  let interrupted = false;
  const updatedThreads: ThreadCursor[] = [];
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
      for (const id of wake.deliveryIds)
        updatedThreads.push(...(await projectDeliveryState(tx, id, null)));
      continue;
    }
    interrupted = true;
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
    if (runtimeProblemCode) {
      updatedThreads.push(...(await finishWake(tx, wake, "failed", runtimeProblemCode, true)));
      continue;
    }
    if (wake.attempts >= RETRY_DELAYS_MS.length) {
      updatedThreads.push(...(await finishWake(tx, wake, "failed", "retry-exhausted", true)));
      continue;
    }
    await tx.botMessageDelivery.updateMany({
      where: { id: { in: wake.deliveryIds }, state: "delivered" },
      data: { failureCode: "read-unconfirmed" },
    });
    const nextAttempt = wake.attempts + 1;
    await tx.botMessageWake.update({
      where: { id: wake.id },
      data: {
        state: "retry_wait",
        attempts: nextAttempt,
        nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[nextAttempt - 1]!),
        generation: wake.generation + 1,
        clientNonce: `peer-wake:${wake.id}:${wake.generation + 1}`,
        runId: null,
        steeringMessageId: null,
      },
    });
  }
  if (completed && !interrupted) {
    const run = await tx.run.findUnique({
      where: { id: runId },
      select: { botId: true, threadId: true, delegationRootTaskId: true },
    });
    if (run?.delegationRootTaskId) {
      const pending = await tx.botMessageWake.findFirst({
        where: {
          rootTaskId: run.delegationRootTaskId,
          recipientBotId: run.botId,
          recipientThreadId: run.threadId,
          state: { in: ["pending", "sealed"] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (pending) {
        const binding = await bindBotMessageWakeInTransaction(tx, pending.id);
        return {
          continuationRunId: binding.runId,
          updatedThreads: [...updatedThreads, ...binding.updatedThreads],
        };
      }
    }
  }
  return { continuationRunId: null, updatedThreads };
}
