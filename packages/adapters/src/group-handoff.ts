import { createHash } from "node:crypto";
import { runContinueJob } from "@ardurbot/adapter-kit";
import { MessageBlock, TaskCardRequestSchema } from "@ardurbot/contracts";
import {
  botMessageHopExhausted,
  nextBotMessageHop,
  redactTaskValue,
  renderGroupMembersContext,
  taskCardGoal,
  taskCardPrompt,
} from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  lockOwnedGroup,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { DelegationResolver } from "./delegation.js";
import { delegationFailure, prepareDelegation } from "./delegation.js";
import type { ExecutorDeps } from "./executor.js";

export async function handoffToGroupBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs"> & {
    resolveDelegationPin?: DelegationResolver;
  },
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
  },
  groupId: string,
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    card?: unknown;
    tokens?: number;
    mode?: "handoff" | "assign";
  },
) {
  input = { ...input, message: redactTaskValue(input.message) };
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      try {
        await lockOwnedGroup(tx, run, groupId);
      } catch (error) {
        if (error instanceof IsolationError)
          return { error: "group is no longer available" } as const;
        throw error;
      }
      const [group, activeSource] = await Promise.all([
        tx.chatGroup.findFirst({
          where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
          include: {
            members: {
              where: { bot: { archivedAt: null } },
              include: { bot: { select: { id: true, name: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
        tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: "running",
          },
          select: {
            id: true,
            goalId: true,
            sourceMessage: { select: { blocks: true } },
          },
        }),
      ]);
      if (!group || !activeSource) return { error: "source run is no longer active" } as const;
      if (!group.members.some((member) => member.bot.id === run.botId)) {
        return { error: "source bot is no longer a group member" } as const;
      }

      let targetId = input.bot_id?.trim();
      if (
        input.mode === "assign" &&
        targetId &&
        !group.members.some((member) => member.bot.id === targetId)
      ) {
        const name = targetId.toLowerCase();
        targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
      }
      if (!targetId && input.confirm_name?.trim()) {
        const name = input.confirm_name.trim().toLowerCase();
        targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
      }
      if (!targetId) return { error: "handoff target bot is required" } as const;
      if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
      if (!group.members.some((member) => member.bot.id === targetId)) {
        return { error: "handoff target is not a group member" } as const;
      }
      const goal =
        input.mode === "assign"
          ? await tx.teamGoal.findFirst({
              where: {
                id: activeSource.goalId ?? "",
                groupId,
                threadId: run.threadId,
                coordinatorBotId: run.botId,
                status: "running",
              },
            })
          : null;
      if (input.mode === "assign" && (!goal || group.coordinatorBotId !== run.botId)) {
        return { error: "only the active goal coordinator can assign room work" } as const;
      }
      const card = input.mode === "assign" ? TaskCardRequestSchema.safeParse(input.card) : null;
      if (card && !card.success) return { error: "assign requires a valid task card" } as const;
      // A card-carrying handoff (comparisons, assignments) may leave the message blank;
      // the visible line then falls back to the card's goal instead of posting empty.
      const visibleMessage = input.message.trim();
      if (!visibleMessage && !input.card)
        return { error: "Give the handoff a message describing the next stage." } as const;
      const deliveryKey =
        input.mode === "assign"
          ? `group-handoff:${run.id}:${targetId}:${createHash("sha256")
              .update(JSON.stringify({ card: card?.data, message: input.message.trim() }))
              .digest("hex")}`
          : `group-handoff:${run.id}`;

      const existing = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: deliveryKey } },
        select: {
          sourceRuns: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true, botId: true },
          },
        },
      });
      if (existing) {
        const nextRun = existing.sourceRuns[0];
        const events = await tx.event.findMany({
          where: {
            threadId: run.threadId,
            runId: run.id,
            type: input.mode === "assign" ? "goal.assigned" : "group.handoff",
          },
          orderBy: { seq: "desc" },
          select: { seq: true, payload: true },
        });
        const event =
          input.mode === "assign"
            ? events.find(
                (candidate) =>
                  (candidate.payload as { deliveryKey?: string }).deliveryKey === deliveryKey,
              )
            : events[0];
        if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
        return { ok: true, botId: nextRun.botId, runId: nextRun.id, eventSeq: event.seq } as const;
      }

      let sourceBlocks: MessageBlock[] = [];
      if (activeSource.sourceMessage) {
        const parsedSource = MessageBlock.array().safeParse(activeSource.sourceMessage.blocks);
        if (!parsedSource.success) {
          return { error: "cannot verify the group handoff chain" } as const;
        }
        sourceBlocks = parsedSource.data;
      }
      const sourceHandoff = sourceBlocks.find(
        (block): block is Extract<MessageBlock, { kind: "handoff" }> => block.kind === "handoff",
      );
      if (sourceHandoff?.fromBotId === targetId) {
        return {
          error:
            "do not hand this stage back to its sender; post the result in the shared thread instead",
        } as const;
      }
      const hop = nextBotMessageHop(sourceHandoff?.hop);
      if (botMessageHopExhausted(hop)) {
        return {
          error:
            "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
        } as const;
      }

      const admitted = await prepareDelegation(
        tx,
        {
          ...run,
          parentRunId: run.id,
          actingBotId: targetId,
          actingName: group.members.find((member) => member.bot.id === targetId)!.bot.name,
          kind: "group-handoff",
          admissionKey: deliveryKey,
          prompt: input.message,
          card: input.card,
          tokens: goal
            ? Math.min(input.tokens ?? goal.perWorkerTokens, goal.perWorkerTokens)
            : undefined,
          deadlineAt: goal
            ? new Date(
                Math.min(
                  goal.untilAt.getTime(),
                  card?.success && card.data.deadlineAt
                    ? new Date(card.data.deadlineAt).getTime()
                    : Infinity,
                ),
              )
            : undefined,
          targetThreadId: run.threadId,
        },
        deps.resolveDelegationPin,
      );
      if (!admitted.ok) return admitted;
      const handoffText = visibleMessage || taskCardGoal(admitted.record.card) || "";
      const handoffBlock: MessageBlock = {
        kind: "handoff",
        fromBotId: run.botId,
        toBotId: targetId,
        text: handoffText,
        hop,
      };
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks: [handoffBlock],
        botId: run.botId,
        runId: run.id,
        clientNonce: deliveryKey,
        markUnread: false,
      });
      const task = await tx.task.create({
        data: {
          spaceId: run.spaceId,
          botId: targetId,
          threadId: run.threadId,
          userId: run.userId,
          prompt: admitted.record.card
            ? taskCardPrompt(admitted.record.card, admitted.record.actingName)
            : input.message,
          status: "queued",
        },
      });
      const nextRun = await tx.run.create({
        data: {
          ...admitted.runData,

          spaceId: run.spaceId,
          botId: targetId,
          threadId: run.threadId,
          taskId: task.id,
          userId: run.userId,
          status: "queued",
          trigger: "follow_up",
          sourceMessageId: message.id,
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "group.handoff",
        runId: run.id,
        payload: {
          messageId: message.id,
          fromBotId: run.botId,
          toBotId: targetId,
          text: handoffText,
        },
      });
      const assignedEvent = goal
        ? await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "goal.assigned",
            runId: run.id,
            payload: {
              goalId: goal.id,
              delegationId: admitted.record.id,
              botId: targetId,
              deliveryKey,
            },
          })
        : null;
      await tx.delegation.update({
        where: { id: admitted.record.id },
        data: { runId: nextRun.id },
      });
      await touchGroupUpdatedAt(tx, groupId);
      return {
        ok: true,
        botId: targetId,
        runId: nextRun.id,
        eventSeq: assignedEvent?.seq ?? event.seq,
        differences: admitted.record.differences,
        delegationId: admitted.record.id,
      } as const;
    }),
  ).catch(delegationFailure);
  if ("error" in committed) return committed;
  await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("group handoff realtime notification", error);
  });
  await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
    // The queued run is durable and the job reconciler will repair a missed immediate wake.
    getLogger().error("group handoff enqueue", error);
  });
  return {
    ok: true,
    botId: committed.botId,
    runId: committed.runId,
    differences: "differences" in committed ? committed.differences : [],
    delegationId: "delegationId" in committed ? committed.delegationId : undefined,
    note:
      input.mode === "assign"
        ? "Assignment recorded. Continue coordinating this turn."
        : "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
  includeRoster = true,
): Promise<string | undefined> {
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: {
          bot: { select: { id: true, name: true, title: true, description: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group) return undefined;
  return renderGroupMembersContext(
    group.name,
    group.members.map((member) => member.bot),
    self,
    includeRoster,
  );
}
