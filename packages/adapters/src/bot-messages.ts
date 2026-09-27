import { createHash, randomUUID } from "node:crypto";
import { runContinueJob } from "@ardurbot/adapter-kit";
import type { BotMessageIntent, MessageBlock } from "@ardurbot/contracts";
import { TaskCardRequestSchema } from "@ardurbot/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  redactTaskValue,
  resolveBotAddress,
  taskCardPrompt,
} from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import {
  appendEventInTransaction,
  BotInboxFullError,
  createThreadMessageInTransaction,
  goalBotAuthorityFingerprint,
  withTransactionRetry,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { recordInboxFullChip, replyToBotDelivery } from "./bot-comms.js";
import type { DelegationResolver } from "./delegation.js";
import { delegationFailure, prepareDelegation } from "./delegation.js";
import type { ExecutorDeps } from "./executor.js";
import {
  peerArtifactWhere,
  peerDocumentWhere,
  peerReadOnlyRuntimeSupported,
} from "./peer-policy.js";
import { updateTaskCard } from "./task-cards.js";

class UnsupportedPeerRuntimeError extends Error {}

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { blocks: true } } },
  });
  const context = botMessageContext(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!context) return undefined;
  const replyBlocks = Array.isArray(source?.replyTo?.blocks)
    ? (source.replyTo.blocks as MessageBlock[])
    : [];
  const repliesToRequest = replyBlocks.some(
    (block) =>
      block.kind === "bot_message_sent" &&
      (block.intent === undefined || block.intent === "request" || block.intent === "question"),
  );
  return { ...context, repliesToRequest };
}

type BotMessageResult =
  | { ok: false; error: string; problem?: unknown; noticeEventSeq?: number }
  | {
      ok: true;
      botId: string;
      note: string;
      name?: string;
      delivered?: string;
      replayed?: true;
      deliveryId?: string;
      runId?: string;
      delegationId?: string;
      differences?: string[];
    };

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs"> & {
    resolveDelegationPin?: DelegationResolver;
  },
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
    goalId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
    inReplyToDeliveryId?: string;
    card?: unknown;
  },
  options?: { allowTerminalSource?: boolean },
): Promise<BotMessageResult> {
  const message = redactTaskValue(String(input.message ?? "").trim());
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return {
      ok: false as const,
      error: `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit`,
    };
  }

  if (input.inReplyToDeliveryId) {
    if (input.intent !== "result" && input.intent !== "question")
      return { ok: false as const, error: "A reply must be a result or a question." };
    return replyToBotDelivery(deps, run, sender, {
      ...input,
      message,
      intent: input.intent,
      inReplyToDeliveryId: input.inReplyToDeliveryId,
    });
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  const hop = nextBotMessageHop(sourceContext?.hop);

  const sourceThread = await deps.prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { groupId: true },
  });
  const groupId = sourceThread?.groupId;
  const goalRequest = Boolean(groupId);
  const goal = goalRequest
    ? await deps.prisma.teamGoal.findFirst({
        where: {
          id: run.goalId ?? "",
          groupId: groupId!,
          threadId: run.threadId,
          coordinatorBotId: run.botId,
          spaceId: run.spaceId,
          userId: run.userId,
        },
      })
    : null;
  const goalCard =
    goalRequest && (intent === "request" || intent === "question")
      ? TaskCardRequestSchema.safeParse(input.card)
      : null;
  if (goalCard && !goalCard.success)
    return { ok: false as const, error: "Goal desk requests need a valid task card." };
  if (goalCard?.success && goalCard.data.inputs.some((item) => item.type === "url"))
    return { ok: false as const, error: "Goal desk requests cannot open web links." };
  if (goalRequest && !input.deliveryKey)
    return { ok: false as const, error: "Goal desk requests need a delivery key." };
  if (goal && input.deliveryKey && goalCard?.success) {
    const recorded = await deps.prisma.delegation.findFirst({
      where: {
        admissionKey: `bot-message:${input.deliveryKey}`,
        spaceId: run.spaceId,
        userId: run.userId,
      },
    });
    if (recorded) {
      const recordedCard = recorded.card as Record<string, unknown> | null;
      const card =
        recordedCard && typeof recordedCard === "object" && !Array.isArray(recordedCard)
          ? TaskCardRequestSchema.safeParse({
              goal: recordedCard.goal,
              inputs: recordedCard.inputs,
              doneWhen: recordedCard.doneWhen,
              deadlineAt: recordedCard.deadlineAt,
            })
          : null;
      const recordedRun = recorded.runId
        ? await deps.prisma.run.findUnique({
            where: { id: recorded.runId },
            select: { sourceMessageId: true },
          })
        : null;
      const inbound = recordedRun?.sourceMessageId
        ? await deps.prisma.message.findUnique({
            where: { id: recordedRun.sourceMessageId },
            select: { blocks: true },
          })
        : null;
      const received = Array.isArray(inbound?.blocks)
        ? (inbound.blocks as MessageBlock[]).find((block) => block.kind === "bot_message_received")
        : undefined;
      if (
        recorded.kind !== "message" ||
        recorded.rootTaskId !== goal.rootTaskId ||
        recorded.parentRunId !== run.id ||
        recorded.requesterBotId !== run.botId ||
        recorded.spaceId !== run.spaceId ||
        recorded.userId !== run.userId ||
        (input.bot_id !== undefined && input.bot_id !== recorded.actingBotId) ||
        (input.confirm_name !== undefined && input.confirm_name !== recorded.actingName) ||
        !card?.success ||
        JSON.stringify(card.data) !== JSON.stringify(goalCard.data) ||
        received?.kind !== "bot_message_received" ||
        received.fromBotId !== sender.id ||
        received.text !== message ||
        received.intent !== intent ||
        received.delegationId !== recorded.id ||
        !["delivered", "read", "replied", "expired", "failed"].includes(
          received.deliveryState ?? "",
        )
      )
        return { ok: false as const, error: "This delivery key belongs to a different request." };
      return {
        ok: true as const,
        botId: recorded.actingBotId,
        name: recorded.actingName,
        delivered: message,
        replayed: true as const,
        delegationId: recorded.id,
        runId: recorded.runId ?? undefined,
        note: `Already sent to ${recorded.actingName} in this turn; it was not sent again.`,
      };
    }
  }
  if (goalRequest && goal?.status !== "running")
    return { ok: false as const, error: "Only the active goal coordinator can send desk work." };
  const group = goal
    ? await deps.prisma.chatGroup.findFirst({
        where: { id: goal.groupId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
        include: { members: { select: { botId: true } } },
      })
    : null;
  if (goal && (!group || group.coordinatorBotId !== run.botId))
    return { ok: false as const, error: "The goal group is no longer available." };

  const candidates = await deps.prisma.bot.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      archivedAt: null,
      ...(goal ? { groupMembers: { some: { groupId: goal.groupId } } } : {}),
    },
    select: { id: true, name: true, title: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) return { ok: false as const, error: "no bot found with that id or name" };
  if (goal && !group?.members.some((member) => member.botId === target.id))
    return { ok: false as const, error: "Bot unavailable." };
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const parentRun = await deps.prisma.run.findUnique({ where: { id: run.id } });
  if (parentRun?.delegationId && parentRun.goalId)
    return { ok: false as const, error: "Reply to the delivered request or use the task card." };
  if (goal && (parentRun?.goalId !== goal.id || parentRun.delegationId))
    return { ok: false as const, error: "Only the active goal coordinator can send desk work." };
  if (parentRun?.delegationId && !goal) {
    const parentCard = await deps.prisma.delegation.findUnique({
      where: { id: parentRun.delegationId },
      select: { card: true, requesterBotId: true },
    });
    if (
      parentCard?.card &&
      typeof parentCard.card === "object" &&
      !Array.isArray(parentCard.card) &&
      "peerMode" in parentCard.card &&
      parentCard.card.peerMode === "read-only" &&
      (target.id !== parentCard.requesterBotId || !["status", "result", "fyi"].includes(intent))
    )
      return { ok: false as const, error: "This peer task can only report to its coordinator." };
  }
  if (parentRun?.delegationId && ["status", "result", "fyi"].includes(intent)) {
    const delegation = await deps.prisma.delegation.findUniqueOrThrow({
      where: { id: parentRun.delegationId },
    });
    if (target.id === delegation.requesterBotId) {
      await updateTaskCard(deps, {
        ...run,
        runId: run.id,
        executionId: input.deliveryKey ?? `peer:${run.id}:${message}`,
        tool: "report_progress",
        args: { text: message.slice(0, 2000) },
      });
      return {
        ok: true as const,
        botId: target.id,
        delegationId: delegation.id,
        note: "Recorded for the coordinator; completion will produce one summary.",
      };
    }
  }
  const targetThreadId = target.thread.id;

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const deliveryKey = input.deliveryKey ? `bot-message:${input.deliveryKey}` : undefined;
  const deliveryId = goal ? randomUUID() : undefined;
  const replayed = (delegationId?: string, runId?: string) =>
    ({
      ok: true as const,
      botId: target.id,
      name: target.name,
      delivered: message,
      replayed: true as const,
      ...(delegationId ? { delegationId } : {}),
      ...(runId ? { runId } : {}),
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    }) as const;

  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message, intent });
  const outboundBase: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
    ...(deliveryId ? { deliveryId } : {}),
  };

  let committed:
    | {
        ok: true;
        runId?: string;
        targetEventSeq: number;
        senderEventSeq: number;
        differences?: string[];
        delegationId?: string;
      }
    | {
        ok: false;
        error: string;
        noticeEventSeq?: number;
      }
    | {
        ok: true;
        replayed: true;
        delegationId?: string;
        runId?: string;
      };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (goal) {
          await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${goal.groupId} AND "spaceId" = ${run.spaceId} AND "userId" = ${run.userId} FOR UPDATE`;
        }
        // Owner sends, run claiming, and archive take the recipient bot before its thread.
        await tx.$queryRaw`SELECT id FROM bots WHERE id = ${target.id} AND "spaceId" = ${run.spaceId} AND "userId" = ${run.userId} FOR UPDATE`;
        const rootTaskId = goal?.rootTaskId ?? parentRun?.delegationRootTaskId ?? parentRun?.taskId;
        const root = rootTaskId
          ? await tx.delegationRoot.findUnique({
              where: { rootTaskId },
              select: { coordinatorThreadId: true },
            })
          : null;
        const coordinatorThreadId = root?.coordinatorThreadId ?? run.threadId;
        for (const threadId of [
          coordinatorThreadId,
          ...[run.threadId, targetThreadId].filter((id) => id !== coordinatorThreadId).sort(),
        ]) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          const already = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
            select: { id: true, runId: true, blocks: true },
          });
          if (already) {
            const block = Array.isArray(already.blocks)
              ? (already.blocks as MessageBlock[]).find(
                  (item) => item.kind === "bot_message_received",
                )
              : undefined;
            if (goal && goalCard?.success) {
              const recorded =
                block?.kind === "bot_message_received" && block.delegationId
                  ? await tx.delegation.findUnique({
                      where: { id: block.delegationId },
                      select: {
                        card: true,
                        parentRunId: true,
                        actingBotId: true,
                        rootTaskId: true,
                        spaceId: true,
                        userId: true,
                      },
                    })
                  : null;
              const card =
                recorded?.card && typeof recorded.card === "object" && !Array.isArray(recorded.card)
                  ? TaskCardRequestSchema.safeParse({
                      goal: recorded.card.goal,
                      inputs: recorded.card.inputs,
                      doneWhen: recorded.card.doneWhen,
                      deadlineAt: recorded.card.deadlineAt,
                    })
                  : null;
              if (
                !recorded ||
                !card?.success ||
                !goalCard?.success ||
                recorded.parentRunId !== run.id ||
                recorded.actingBotId !== target.id ||
                recorded.rootTaskId !== goal.rootTaskId ||
                recorded.spaceId !== run.spaceId ||
                recorded.userId !== run.userId ||
                block?.kind !== "bot_message_received" ||
                block.fromBotId !== run.botId ||
                block.text !== message ||
                block.intent !== intent ||
                JSON.stringify(card.data) !== JSON.stringify(goalCard.data)
              )
                return {
                  ok: false as const,
                  error: "This delivery key belongs to a different request.",
                };
            } else if (goal) {
              const recorded = await tx.botMessageDelivery.findUnique({
                where: {
                  spaceId_userId_idempotencyKey: {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    idempotencyKey: deliveryKey,
                  },
                },
              });
              const expected = createHash("sha256")
                .update(JSON.stringify([target.id, intent, message]))
                .digest("hex");
              if (
                !recorded ||
                recorded.inboundMessageId !== already.id ||
                recorded.sourceRunId !== run.id ||
                recorded.recipientBotId !== target.id ||
                recorded.intent !== intent ||
                recorded.requestFingerprint !== expected
              )
                return {
                  ok: false as const,
                  error: "This delivery key belongs to a different request.",
                };
            }
            return {
              ok: true as const,
              replayed: true as const,
              delegationId: block?.delegationId,
              runId: already.runId ?? undefined,
            };
          }
        }

        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: options?.allowTerminalSource ? { in: ["completed", "failed"] } : "running",
          },
          select: { id: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };

        // Re-read the target inside the transaction: it can be archived between
        // resolving it above and committing here.
        const stillAddressable = await tx.bot.findFirst({
          where: {
            id: target.id,
            spaceId: run.spaceId,
            userId: run.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!stillAddressable)
          return { ok: false as const, error: `${target.name} is no longer available` };
        if (goal) {
          const liveGoal = await tx.teamGoal.findFirst({
            where: {
              id: goal.id,
              groupId: goal.groupId,
              status: "running",
              spaceId: run.spaceId,
              userId: run.userId,
              coordinatorBotId: run.botId,
            },
          });
          const liveGroup = await tx.chatGroup.findFirst({
            where: {
              id: goal.groupId,
              spaceId: run.spaceId,
              userId: run.userId,
              archivedAt: null,
              coordinatorBotId: run.botId,
              members: { some: { botId: target.id, bot: { archivedAt: null } } },
            },
          });
          if (!liveGoal || !liveGroup || senderStillRunning.id !== parentRun?.id)
            return { ok: false as const, error: "The goal request is no longer available." };
          const now = new Date();
          const base = { rootTaskId: goal.rootTaskId, kind: "message" as const };
          const turnCount = await tx.delegation.count({
            where: { ...base, parentRunId: run.id },
          });
          const pairCount = await tx.delegation.count({
            where: {
              ...base,
              requesterBotId: run.botId,
              actingBotId: target.id,
              createdAt: { gte: new Date(now.getTime() - 60_000) },
            },
          });
          const hourCount = await tx.delegation.count({
            where: { ...base, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
          });
          if (turnCount >= 2 || pairCount >= 4 || hourCount >= 12) {
            const reason = "Team message limit reached. Review this goal before sending more work.";
            const noticeKey = `goal-message-limit:${goal.id}`;
            const existingNotice = await tx.message.findUnique({
              where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: noticeKey } },
            });
            const notice = existingNotice
              ? null
              : await createThreadMessageInTransaction(tx, {
                  threadId: run.threadId,
                  role: "bot",
                  botId: run.botId,
                  blocks: [{ kind: "text", text: reason }],
                  clientNonce: noticeKey,
                  markUnread: false,
                });
            const event = notice
              ? await appendEventInTransaction(tx, {
                  spaceId: run.spaceId,
                  threadId: run.threadId,
                  botId: run.botId,
                  type: "thread.message.created",
                  payload: {
                    messageId: notice.id,
                    role: "bot",
                    blocks: [{ kind: "text", text: reason }],
                  },
                })
              : null;
            return { ok: false as const, error: reason, noticeEventSeq: event?.seq };
          }
          const pending = await tx.botMessageDelivery.count({
            where: {
              spaceId: run.spaceId,
              userId: run.userId,
              recipientBotId: target.id,
              state: { in: ["queued", "delivered", "read"] },
              outcome: null,
              expiresAt: { gt: now },
            },
          });
          if (pending >= 20) throw new BotInboxFullError();
          if (intent === "request" || intent === "question") {
            const unresolved = await tx.botMessageDelivery.count({
              where: {
                spaceId: run.spaceId,
                userId: run.userId,
                sourceRunId: run.id,
                intent: { in: ["request", "question"] },
                replyDeliveryId: null,
                state: { in: ["queued", "delivered", "read"] },
                expiresAt: { gt: now },
              },
            });
            if (unresolved >= 4) throw new BotInboxFullError();
          }
          if (goalCard?.success) {
            for (const input of goalCard.data.inputs) {
              if (input.type === "document") {
                const document = await tx.memoryRevision.findFirst({
                  where: {
                    documentId: input.documentId,
                    revision: input.revision,
                    deletedAt: null,
                    document: peerDocumentWhere(run),
                  },
                  select: { id: true },
                });
                if (!document)
                  return { ok: false as const, error: "This card document is unavailable." };
              }
              if (input.type === "file") {
                const artifact = await tx.artifact.findFirst({
                  where: {
                    id: input.artifactId,
                    ...peerArtifactWhere({
                      ...run,
                      requesterBotId: run.botId,
                      groupId: goal.groupId,
                    }),
                  },
                  select: { id: true },
                });
                if (!artifact)
                  return { ok: false as const, error: "This card artifact is unavailable." };
              }
            }
          }
        }
        const authorityFingerprint = goal
          ? await goalBotAuthorityFingerprint(tx, {
              spaceId: run.spaceId,
              userId: run.userId,
              goalId: goal.id,
              rootTaskId: goal.rootTaskId,
              botId: target.id,
            })
          : null;

        if (goal && (intent === "status" || intent === "fyi" || intent === "result")) {
          const now = new Date();
          const busyRecipient = Boolean(
            await tx.run.findFirst({
              where: {
                threadId: targetThreadId,
                botId: target.id,
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true },
            }),
          );
          const outboundBlock: MessageBlock = {
            ...outboundBase,
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
            text: message,
            intent,
            hop,
            returnToMessageId: outbound.id,
            deliveryId,
            deliveryState: "delivered",
            ...(busyRecipient ? { queuedForBusy: true } : {}),
          };
          const inbound = await createThreadMessageInTransaction(tx, {
            threadId: targetThreadId,
            role: "user",
            origin: "peer-bot",
            actorId: sender.id,
            blocks: [inboundBlock],
            clientNonce: deliveryKey,
            markUnread: false,
          });
          await tx.botMessageDelivery.create({
            data: {
              id: deliveryId!,
              spaceId: run.spaceId,
              userId: run.userId,
              goalId: goal.id,
              rootTaskId: goal.rootTaskId,
              conversationId: deliveryId!,
              senderBotId: run.botId,
              recipientBotId: target.id,
              senderThreadId: run.threadId,
              recipientThreadId: targetThreadId,
              sourceRunId: run.id,
              sourceGroupId: goal.groupId,
              intent,
              usageRunIds: [run.id],
              outboundMessageId: outbound.id,
              inboundMessageId: inbound.id,
              state: "delivered",
              hop,
              authorityFingerprint: authorityFingerprint!,
              requestFingerprint: createHash("sha256")
                .update(JSON.stringify([target.id, intent, message]))
                .digest("hex"),
              idempotencyKey: deliveryKey!,
              expiresAt: new Date(Math.min(goal.untilAt.getTime(), now.getTime() + 3_600_000)),
              deliveredAt: now,
            },
          });
          const inboundEvent = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: targetThreadId,
            botId: target.id,
            type: "thread.message.created",
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
            targetEventSeq: inboundEvent.seq,
            senderEventSeq: outboundEvent.seq,
          };
        }

        const admitted = await prepareDelegation(
          tx,
          {
            ...run,
            parentRunId: run.id,
            actingBotId: target.id,
            actingName: target.name,
            kind: "message",
            admissionKey: deliveryKey ?? `message:${run.id}:${target.id}`,
            prompt: message,
            card: input.card,
            ...(goal
              ? {
                  peerMode: "read-only" as const,
                  tokens: goal.perWorkerTokens,
                  deadlineAt: new Date(
                    Math.min(
                      goal.untilAt.getTime(),
                      goalCard?.success && goalCard.data.deadlineAt
                        ? new Date(goalCard.data.deadlineAt).getTime()
                        : Infinity,
                    ),
                  ),
                }
              : {}),
          },
          deps.resolveDelegationPin,
        );
        if (!admitted.ok) return admitted;
        if (
          goal &&
          !peerReadOnlyRuntimeSupported(
            String(
              (admitted.record.snapshot as { pin?: { runtimeKind?: string } }).pin?.runtimeKind ??
                "",
            ),
          )
        )
          throw new UnsupportedPeerRuntimeError(
            "This connection cannot run this peer task safely.",
          );
        const busyRecipient = goal
          ? Boolean(
              await tx.run.findFirst({
                where: {
                  threadId: targetThreadId,
                  botId: target.id,
                  status: {
                    in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                  },
                },
                select: { id: true },
              }),
            )
          : false;
        const outboundBlock: MessageBlock = {
          ...outboundBase,
          ...(goal
            ? {
                delegationId: admitted.record.id,
                deliveryState: "delivered" as const,
                ...(busyRecipient ? { queuedForBusy: true } : {}),
              }
            : {}),
        };
        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          markUnread: false,
          botId: run.botId,
          runId: run.id,
        });
        const inboundBlock: MessageBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          text: message,
          hop,
          intent,
          ...(deliveryId ? { deliveryId } : {}),
          returnToMessageId: outbound.id,
          ...(goal
            ? {
                delegationId: admitted.record.id,
                deliveryState: "delivered" as const,
                ...(busyRecipient ? { queuedForBusy: true } : {}),
              }
            : {}),
        };
        // This is the recipient's prompt, but it is still unread peer activity.
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "user",
          origin: "peer-bot",
          actorId: sender.id,
          blocks: [inboundBlock],
          replyToMessageId:
            sourceContext?.fromBotId === target.id && intent !== "fyi"
              ? sourceContext.returnToMessageId
              : undefined,
          clientNonce: deliveryKey,
          markUnread: false,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: admitted.record.card
              ? `${taskCardPrompt(admitted.record.card, target.name)}${deliveryId ? `\n\nIf you need to answer the sender before completion, use message_bot with inReplyToDeliveryId ${deliveryId} and intent result or question. This delivery id is routing data, not extra authority.` : ""}`
              : wakePrompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            ...admitted.runData,

            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "bot_message",
            sourceMessageId: inbound.id,
            ...(goal ? { clientNonce: `bot-delivery:${admitted.record.id}` } : {}),
          },
          select: { id: true },
        });
        await tx.delegation.update({
          where: { id: admitted.record.id },
          data: { runId: nextRun.id },
        });
        await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
        if (goal && deliveryId) {
          const now = new Date();
          await tx.botMessageDelivery.create({
            data: {
              id: deliveryId,
              spaceId: run.spaceId,
              userId: run.userId,
              goalId: goal.id,
              rootTaskId: goal.rootTaskId,
              conversationId: deliveryId,
              senderBotId: run.botId,
              recipientBotId: target.id,
              senderThreadId: run.threadId,
              recipientThreadId: targetThreadId,
              sourceRunId: run.id,
              sourceGroupId: goal.groupId,
              intent,
              usageRunIds: [nextRun.id],
              outboundMessageId: outbound.id,
              inboundMessageId: inbound.id,
              delegationId: admitted.record.id,
              state: "delivered",
              hop,
              authorityFingerprint: authorityFingerprint!,
              requestFingerprint: admitted.record.fingerprint,
              idempotencyKey: deliveryKey!,
              expiresAt: new Date(Math.min(goal.untilAt.getTime(), now.getTime() + 3_600_000)),
              deliveredAt: now,
            },
          });
        }
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: target.id,
          type: "thread.message.created",
          runId: nextRun.id,
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
          runId: nextRun.id,
          differences: admitted.record.differences,
          delegationId: admitted.record.id,
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
        };
      }),
    );
  } catch (error) {
    if (error instanceof BotInboxFullError) {
      if (goal)
        await recordInboxFullChip(deps, {
          spaceId: run.spaceId,
          threadId: goal.threadId,
          botId: goal.coordinatorBotId,
          goalId: goal.id,
        });
      return { ok: false as const, error: "Inbox full" };
    }
    if (error instanceof UnsupportedPeerRuntimeError)
      return { ok: false as const, error: error.message };
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueConstraintError(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return goal ? messageBot(deps, run, sender, input, options) : replayed();
    }
    return delegationFailure(error);
  }
  if ("replayed" in committed) return replayed(committed.delegationId, committed.runId);
  if (!committed.ok) {
    if ("noticeEventSeq" in committed && committed.noticeEventSeq)
      await deps.events.notify(run.threadId, committed.noticeEventSeq).catch(() => undefined);
    return committed;
  }

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  if (committed.runId)
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      // The queued run is durable; the job reconciler repairs a missed wake.
      getLogger().error("bot message enqueue", error);
    });
  return {
    ok: true as const,
    botId: target.id,
    name: target.name,
    delivered: message,
    delegationId: committed.delegationId,
    runId: committed.runId,
    differences: committed.differences,
    note: `Sent to ${target.name}. Delivery is async. Continue independent work. Progress stays on the task card; completion produces one coordinator summary.`,
  };
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs"> & {
    resolveDelegationPin?: DelegationResolver;
  },
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
) {
  const saved = await deps.prisma.run.findUnique({ where: { id: run.id } });
  if (saved?.delegationId) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  if (!source) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sourceIntent = source.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === source.fromBotId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: source.fromBotId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    { allowTerminalSource: true },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
