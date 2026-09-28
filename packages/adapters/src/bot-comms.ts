import { createHash, randomUUID } from "node:crypto";
import { runContinueJob } from "@ardurbot/adapter-kit";
import type { MessageBlock } from "@ardurbot/contracts";
import { BOT_MESSAGE_MAX_HOPS, buildBotMessageWakePrompt, peerPairKey } from "@ardurbot/core";
import {
  acknowledgeBotMessageInput,
  appendBotMessageWakeInTransaction,
  appendEventInTransaction,
  BotInboxFullError,
  checkPeerTrafficLimits,
  createThreadMessageInTransaction,
  dispatchBotMessageWake,
  goalBotAuthorityFingerprint,
  lockPeerTrafficPolicy,
  recordPeerTrafficBlock,
  withTransactionRetry,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { ExecutorDeps } from "./executor.js";

type ReplyDeps = Pick<ExecutorDeps, "prisma" | "events" | "jobs">;

export async function acknowledgeBotMessageReceipt(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  input: Parameters<typeof acknowledgeBotMessageInput>[1],
  acceptedDeliveryIds: readonly string[],
) {
  const result = await acknowledgeBotMessageInput(deps.prisma, input, acceptedDeliveryIds);
  if (result.refused) return result;
  for (const update of result.updatedThreads)
    await deps.events.notify(update.threadId, update.seq).catch((error) => {
      getLogger().error("bot message receipt notification", error);
    });
  return result;
}

export async function recordInboxFullChip(
  deps: ReplyDeps,
  input: { spaceId: string; threadId: string; botId: string; goalId: string },
) {
  const seq = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
      const clientNonce = `goal-inbox-full:${input.goalId}`;
      const existing = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: input.threadId, clientNonce } },
        select: { id: true },
      });
      if (existing) return null;
      const blocks: MessageBlock[] = [{ kind: "meta", text: "Inbox full" }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "system",
        blocks,
        clientNonce,
        markUnread: false,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "system", blocks },
      });
      return event.seq;
    }),
  );
  if (seq) await deps.events.notify(input.threadId, seq).catch(() => undefined);
}

export async function replyToBotDelivery(
  deps: ReplyDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
  },
  sender: { id: string; name: string },
  input: {
    inReplyToDeliveryId: string;
    message: string;
    intent: "result" | "question";
    deliveryKey?: string;
    bot_id?: string;
    confirm_name?: string;
  },
) {
  if (sender.id !== run.botId)
    return { ok: false as const, error: "This sender cannot reply to that request." };
  if (!input.deliveryKey) return { ok: false as const, error: "A reply needs a delivery key." };
  const candidate = await deps.prisma.botMessageDelivery.findFirst({
    where: { id: input.inReplyToDeliveryId, spaceId: run.spaceId, userId: run.userId },
  });
  if (!candidate) return { ok: false as const, error: "This reply has no available request." };
  const idempotencyKey = `bot-message:${input.deliveryKey}`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([candidate.id, run.id, input.intent, input.message]))
    .digest("hex");
  const deliveryId = randomUUID();
  try {
    const committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        const paused = await lockPeerTrafficPolicy(tx, {
          spaceId: run.spaceId,
          userId: run.userId,
          groupId: candidate.sourceGroupId ?? candidate.targetGroupId,
        });
        const root = await tx.delegationRoot.findUnique({
          where: { rootTaskId: candidate.rootTaskId },
          select: { coordinatorThreadId: true },
        });
        if (!root) return { ok: false as const, error: "This reply has no active goal." };
        for (const threadId of [
          root.coordinatorThreadId,
          ...[run.threadId, candidate.senderThreadId]
            .filter((id) => id !== root.coordinatorThreadId)
            .sort(),
        ])
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${candidate.rootTaskId} FOR UPDATE`;
        const replay = await tx.botMessageDelivery.findUnique({
          where: {
            spaceId_userId_idempotencyKey: {
              spaceId: run.spaceId,
              userId: run.userId,
              idempotencyKey,
            },
          },
        });
        if (replay) {
          if (
            replay.inReplyToDeliveryId !== candidate.id ||
            replay.sourceRunId !== run.id ||
            replay.intent !== input.intent ||
            replay.requestFingerprint !== fingerprint
          )
            return { ok: false as const, error: "This delivery key belongs to another reply." };
          return { ok: true as const, replayed: true as const, deliveryId: replay.id };
        }
        if (paused) return { ok: false as const, error: "Team messages are paused." };
        const parent = await tx.botMessageDelivery.findUnique({ where: { id: candidate.id } });
        const source = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            userId: run.userId,
            botId: run.botId,
            threadId: run.threadId,
            status: "running",
          },
        });
        const goal = parent?.goalId
          ? await tx.teamGoal.findFirst({
              where: {
                id: parent.goalId,
                rootTaskId: parent.rootTaskId,
                status: "running",
                spaceId: run.spaceId,
                userId: run.userId,
              },
            })
          : null;
        const group = goal
          ? await tx.chatGroup.findFirst({
              where: {
                id: goal.groupId,
                spaceId: run.spaceId,
                userId: run.userId,
                archivedAt: null,
                coordinatorBotId: parent?.senderBotId,
                members: { some: { botId: run.botId, bot: { archivedAt: null } } },
              },
            })
          : null;
        if (
          !parent ||
          !source ||
          !goal ||
          !group ||
          parent.recipientBotId !== run.botId ||
          parent.recipientThreadId !== run.threadId ||
          parent.senderThreadId !== goal.threadId ||
          parent.senderBotId !== goal.coordinatorBotId ||
          !["request", "question"].includes(parent.intent) ||
          !parent.delegationId ||
          parent.delegationId !== source.delegationId ||
          source.delegationRootTaskId !== parent.rootTaskId ||
          source.goalId !== goal.id ||
          source.sourceMessageId !== parent.inboundMessageId ||
          !["delivered", "read"].includes(parent.state) ||
          parent.replyDeliveryId ||
          parent.expiresAt <= new Date() ||
          parent.hop >= BOT_MESSAGE_MAX_HOPS ||
          (input.bot_id && input.bot_id !== parent.senderBotId)
        )
          return { ok: false as const, error: "This reply has no available request." };
        const recipient = await tx.bot.findFirst({
          where: {
            id: parent.senderBotId,
            spaceId: run.spaceId,
            userId: run.userId,
            archivedAt: null,
          },
          select: { id: true, name: true },
        });
        if (!recipient || (input.confirm_name && input.confirm_name !== recipient.name))
          return { ok: false as const, error: "The original sender is unavailable." };
        if (input.intent === "question") {
          const now = new Date();
          const limit = await checkPeerTrafficLimits(tx, {
            spaceId: run.spaceId,
            userId: run.userId,
            groupId: goal.groupId,
            goalId: goal.id,
            senderBotId: run.botId,
            recipientBotId: recipient.id,
            wakes: true,
            now,
          });
          if (limit) {
            await recordPeerTrafficBlock(tx, {
              spaceId: run.spaceId,
              userId: run.userId,
              groupId: goal.groupId,
              goalId: goal.id,
              senderBotId: run.botId,
              recipientBotId: recipient.id,
              reason: limit,
              now,
            });
            return { ok: false as const, error: "Team message limit reached." };
          }
        }
        const authorityFingerprint = await goalBotAuthorityFingerprint(tx, {
          spaceId: run.spaceId,
          userId: run.userId,
          goalId: goal.id,
          rootTaskId: parent.rootTaskId,
          botId: recipient.id,
        });
        const now = new Date();
        const busyRecipient = Boolean(
          await tx.run.findFirst({
            where: {
              threadId: parent.senderThreadId,
              botId: recipient.id,
              status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
            },
            select: { id: true },
          }),
        );
        const outboundBlock: MessageBlock = {
          kind: "bot_message_sent",
          toBotId: recipient.id,
          toBotName: recipient.name,
          text: input.message,
          intent: input.intent,
          deliveryId,
          deliveryState: "delivered",
          ...(busyRecipient ? { queuedForBusy: true } : {}),
        };
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          botId: run.botId,
          runId: run.id,
          blocks: [outboundBlock],
          markUnread: false,
        });
        const inboundBlock: MessageBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          recipientBotName: recipient.name,
          text: input.message,
          intent: input.intent,
          hop: parent.hop + 1,
          returnToMessageId: outbound.id,
          deliveryId,
          deliveryState: "delivered",
          ...(busyRecipient ? { queuedForBusy: true } : {}),
        };
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: parent.senderThreadId,
          role: "user",
          origin: "peer-bot",
          actorId: sender.id,
          blocks: [inboundBlock],
          replyToMessageId: parent.outboundMessageId,
          clientNonce: idempotencyKey,
          markUnread: false,
        });
        const delivery = await tx.botMessageDelivery.create({
          data: {
            id: deliveryId,
            spaceId: run.spaceId,
            userId: run.userId,
            goalId: goal.id,
            rootTaskId: parent.rootTaskId,
            conversationId: parent.conversationId,
            inReplyToDeliveryId: parent.id,
            senderBotId: run.botId,
            recipientBotId: recipient.id,
            pairKey: peerPairKey(run.botId, recipient.id),
            senderThreadId: run.threadId,
            recipientThreadId: parent.senderThreadId,
            sourceRunId: run.id,
            sourceDelegationId: source.delegationId,
            usageRunIds: [run.id],
            sourceGroupId: null,
            targetGroupId: goal.groupId,
            intent: input.intent,
            outboundMessageId: outbound.id,
            inboundMessageId: inbound.id,
            state: "delivered",
            hop: parent.hop + 1,
            authorityFingerprint,
            requestFingerprint: fingerprint,
            idempotencyKey,
            expiresAt: new Date(Math.min(goal.untilAt.getTime(), now.getTime() + 3_600_000)),
            deliveredAt: now,
          },
        });
        if (input.intent === "result")
          await tx.botMessageDelivery.update({
            where: { id: parent.id },
            data: { replyDeliveryId: delivery.id, state: "replied", repliedAt: now },
          });
        if (input.intent === "result") {
          for (const messageId of [parent.outboundMessageId, parent.inboundMessageId]) {
            if (!messageId) continue;
            const projection = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
            const blocks = (projection.blocks as MessageBlock[]).map((block) =>
              (block.kind === "bot_message_sent" || block.kind === "bot_message_received") &&
              block.deliveryId === parent.id
                ? { ...block, deliveryState: "replied" as const, queuedForBusy: false }
                : block,
            );
            await tx.message.update({ where: { id: messageId }, data: { blocks } });
            await appendEventInTransaction(tx, {
              spaceId: run.spaceId,
              threadId: projection.threadId,
              botId: projection.threadId === goal.threadId ? goal.coordinatorBotId : run.botId,
              type: "thread.message.updated",
              payload: { messageId, blocks },
            });
          }
        }
        // Completion and an explicit reply claim the same coordinator continuation.
        if (parent.delegationId && input.intent === "result")
          await tx.delegation.updateMany({
            where: { id: parent.delegationId, coordinatorWokenAt: null },
            data: { coordinatorWokenAt: now },
          });
        const queuedRunIds = await appendBotMessageWakeInTransaction(
          tx,
          delivery,
          buildBotMessageWakePrompt({ from: sender, text: input.message, intent: input.intent })
            .length,
        );
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: parent.senderThreadId,
          botId: recipient.id,
          type: "thread.message.created",
          runId: run.id,
          payload: { messageId: inbound.id, role: "user", blocks: [inboundBlock] },
        });
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: run.id,
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        return {
          ok: true as const,
          deliveryId: delivery.id,
          recipientBotId: recipient.id,
          recipientName: recipient.name,
          recipientThreadId: parent.senderThreadId,
          senderEventSeq: outboundEvent.seq,
          recipientEventSeq: inboundEvent.seq,
          queuedRunIds,
        };
      }),
    );
    if (!committed.ok) return committed;
    if ("replayed" in committed)
      return {
        ok: true as const,
        botId: candidate.senderBotId,
        deliveryId: committed.deliveryId,
        replayed: true as const,
        note: "Already sent in this turn; it was not sent again.",
      };
    await deps.events.notify(run.threadId, committed.senderEventSeq).catch(() => undefined);
    await deps.events
      .notify(committed.recipientThreadId, committed.recipientEventSeq)
      .catch(() => undefined);
    for (const runId of committed.queuedRunIds)
      await deps.jobs
        .enqueue(runContinueJob(runId))
        .catch((error) => getLogger().error("peer wake enqueue", error));
    const pending = await deps.prisma.botMessageWake.findFirst({
      where: { deliveryIds: { has: committed.deliveryId }, state: "pending" },
      select: { id: true },
    });
    const dispatched = pending ? await dispatchBotMessageWake(deps.prisma, pending.id) : null;
    for (const update of dispatched?.updatedThreads ?? [])
      await deps.events.notify(update.threadId, update.seq).catch((error) => {
        getLogger().error("peer wake receipt notification", error);
      });
    if (dispatched?.runId)
      await deps.jobs
        .enqueue(runContinueJob(dispatched.runId))
        .catch((error) => getLogger().error("peer wake enqueue", error));
    return {
      ok: true as const,
      botId: committed.recipientBotId,
      name: committed.recipientName,
      delivered: input.message,
      deliveryId: committed.deliveryId,
      note: `Sent to ${committed.recipientName}. Delivery is async.`,
    };
  } catch (error) {
    if (error instanceof BotInboxFullError) {
      await recordInboxFullChip(deps, {
        spaceId: run.spaceId,
        threadId: candidate.senderThreadId,
        botId: candidate.senderBotId,
        goalId: candidate.goalId!,
      });
      return { ok: false as const, error: "Inbox full" };
    }
    if (error && typeof error === "object" && "code" in error && error.code === "P2002")
      return replyToBotDelivery(deps, run, sender, input);
    throw error;
  }
}
