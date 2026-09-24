import { runContinueJob } from "@ardurbot/adapter-kit";
import { MessageBlock } from "@ardurbot/contracts";
import {
  botMessageHopExhausted,
  nextBotMessageHop,
  redactTaskValue,
  renderGroupMembersContext,
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
  input: { bot_id?: string; confirm_name?: string; message: string; card?: unknown },
) {
  input = { ...input, message: redactTaskValue(input.message) };
  const deliveryKey = `group-handoff:${run.id}`;
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
          select: { id: true, sourceMessage: { select: { blocks: true } } },
        }),
      ]);
      if (!group || !activeSource) return { error: "source run is no longer active" } as const;
      if (!group.members.some((member) => member.bot.id === run.botId)) {
        return { error: "source bot is no longer a group member" } as const;
      }

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
        const event = await tx.event.findFirst({
          where: { threadId: run.threadId, runId: run.id, type: "group.handoff" },
          orderBy: { seq: "desc" },
          select: { seq: true },
        });
        if (!nextRun || !event) return { error: "recorded handoff is incomplete" } as const;
        return { ok: true, botId: nextRun.botId, runId: nextRun.id, eventSeq: event.seq } as const;
      }

      let targetId = input.bot_id?.trim();
      if (!targetId && input.confirm_name?.trim()) {
        const name = input.confirm_name.trim().toLowerCase();
        targetId = group.members.find((member) => member.bot.name.toLowerCase() === name)?.bot.id;
      }
      if (!targetId) return { error: "handoff target bot is required" } as const;
      if (targetId === run.botId) return { error: "cannot hand off to yourself" } as const;
      if (!group.members.some((member) => member.bot.id === targetId)) {
        return { error: "handoff target is not a group member" } as const;
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
        },
        deps.resolveDelegationPin,
      );
      if (!admitted.ok) return admitted;
      const handoffBlock: MessageBlock = {
        kind: "handoff",
        fromBotId: run.botId,
        toBotId: targetId,
        text: input.message,
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
          text: input.message,
        },
      });
      await tx.delegation.update({
        where: { id: admitted.record.id },
        data: { runId: nextRun.id },
      });
      await touchGroupUpdatedAt(tx, groupId);
      return {
        ok: true,
        botId: targetId,
        runId: nextRun.id,
        eventSeq: event.seq,
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
    note: "Handoff recorded. End this turn without narrating it; the next bot owns the next stage.",
  };
}

export async function loadGroupContext(
  prisma: PrismaClient,
  groupId: string,
  self: { id: string; name: string },
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
  );
}
