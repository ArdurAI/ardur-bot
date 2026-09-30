import type { ChiefActivity, MessageBlock } from "@ardurbot/contracts";
import {
  ChiefDispatchSchema,
  MessageBlock as MessageBlockSchema,
  TaskCardSchema,
} from "@ardurbot/contracts";
import { chiefActivityShouldPublish, chiefResult, withChiefActivity } from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = { spaceId: string; userId: string };
/** Recovery also settles the line when the executor died before its final projection. */
export async function settleChiefActivity(prisma: PrismaClient, delegationId: string) {
  const row = await prisma.delegation.findUnique({ where: { id: delegationId } });
  if (!row?.runId) return undefined;
  const plan = await prisma.chiefPlan.findFirst({
    where: {
      spaceId: row.spaceId,
      userId: row.userId,
      dispatch: { path: ["delegationId"], equals: delegationId },
    },
  });
  const dispatch = ChiefDispatchSchema.safeParse(plan?.dispatch).data;
  const run = await prisma.run.findUnique({ where: { id: row.runId } });
  if (
    !plan ||
    !dispatch ||
    !run ||
    !["completed", "failed", "cancelled", "waiting_input", "waiting_takeover"].includes(run.status)
  )
    return undefined;
  return projectChiefActivity(prisma, {
    spaceId: row.spaceId,
    userId: row.userId,
    botId: row.actingBotId,
    planId: plan.id,
    activity: {
      revision: plan.revision,
      runId: row.runId,
      delegationId,
      attempt: run.leaseFence,
      sourceSeq: (dispatch.activity?.sourceSeq ?? 0) + 1,
      key: dispatch.activity?.key ?? "working",
      state:
        run.status === "completed"
          ? "completed"
          : run.status === "failed"
            ? "failed"
            : run.status === "cancelled"
              ? "stopped"
              : "waiting",
      updatedAt: new Date().toISOString(),
    },
  });
}
/** A safe projection into one committed dispatch, not a private-desk subscription. */
export async function projectChiefActivity(
  prisma: PrismaClient,
  input: Scope & {
    planId: string;
    botId: string;
    activity: ChiefActivity;
  },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      let plan = await tx.chiefPlan.findFirst({
        where: { id: input.planId, spaceId: input.spaceId, userId: input.userId },
      });
      if (!plan) return undefined;
      // Coordinator thread first. No remote call or worker-thread lock here.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${plan.threadId} FOR UPDATE`;
      plan = await tx.chiefPlan.findUniqueOrThrow({ where: { id: plan.id } });
      const parsed = ChiefDispatchSchema.safeParse(plan.dispatch);
      const saved = plan.dispatch as {
        messageId?: string;
        publishedActivity?: ChiefActivity;
      } | null;
      if (
        !parsed.success ||
        !saved?.messageId ||
        plan.revision !== input.activity.revision ||
        parsed.data.memberId !== input.botId
      )
        return undefined;
      const run = await tx.run.findFirst({
        where: {
          id: input.activity.runId,
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
        },
      });
      if (
        !run ||
        run.delegationId !== input.activity.delegationId ||
        run.leaseFence !== input.activity.attempt
      )
        return undefined;
      const group = await tx.chatGroup.findFirst({
        where: {
          id: plan.groupId,
          spaceId: plan.spaceId,
          userId: plan.userId,
          archivedAt: null,
          coordinatorBotId: plan.chiefBotId,
          members: { some: { botId: input.botId } },
        },
      });
      if (!group) return undefined;
      const authoritative: ChiefActivity["state"] =
        run.status === "completed"
          ? "completed"
          : run.status === "failed"
            ? "failed"
            : run.status === "cancelled"
              ? "stopped"
              : ["waiting_input", "waiting_takeover"].includes(run.status)
                ? "waiting"
                : input.activity.state;
      if (
        (input.activity.state === "active" || input.activity.state === "idle") &&
        (run.status !== "running" || run.cancelRequestedAt)
      )
        return undefined;
      const next = withChiefActivity(parsed.data, { ...input.activity, state: authoritative });
      if (next === parsed.data) return undefined;
      const message = await tx.message.findFirst({
        where: { id: saved.messageId, threadId: plan.threadId },
      });
      if (!message) return undefined;
      const publish = chiefActivityShouldPublish(saved.publishedActivity, next.activity!);
      await tx.chiefPlan.update({
        where: { id: plan.id },
        data: {
          dispatch: {
            ...next,
            messageId: saved.messageId,
            ...(publish
              ? { publishedActivity: next.activity }
              : saved.publishedActivity
                ? { publishedActivity: saved.publishedActivity }
                : {}),
          } as Prisma.InputJsonValue,
        },
      });
      const blocks = MessageBlockSchema.array()
        .parse(message.blocks)
        .map((block) =>
          (block.kind === "handoff" || block.kind === "bot_message_sent") &&
          block.chiefDispatch?.requestMessageId === plan.sourceMessageId
            ? { ...block, chiefDispatch: next }
            : block,
        );
      await tx.message.update({ where: { id: message.id }, data: { blocks } });
      if (!publish) return undefined;
      return appendEventInTransaction(tx, {
        spaceId: plan.spaceId,
        threadId: plan.threadId,
        botId: plan.chiefBotId,
        type: "thread.message.updated",
        payload: {
          messageId: message.id,
          role: message.role,
          blocks,
          messageSeq: message.seq,
          createdAt: message.createdAt.toISOString(),
        },
      });
    }),
  );
}

/** Chief acceptance is not service verification. Publish only an existing saved draft. */
export async function publishChiefDraftResult(
  prisma: PrismaClient,
  input: Scope & { chiefBotId: string; delegationId: string },
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      let plan = await tx.chiefPlan.findFirst({
        where: {
          spaceId: input.spaceId,
          userId: input.userId,
          chiefBotId: input.chiefBotId,
          dispatch: { path: ["delegationId"], equals: input.delegationId },
        },
      });
      if (!plan) return undefined;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${plan.threadId} FOR UPDATE`;
      plan = await tx.chiefPlan.findUniqueOrThrow({ where: { id: plan.id } });
      const dispatch = ChiefDispatchSchema.safeParse(plan.dispatch).data;
      if (
        !dispatch ||
        dispatch.revision !== plan.revision ||
        dispatch.delegationId !== input.delegationId
      )
        return undefined;
      const row = await tx.delegation.findFirst({
        where: {
          id: input.delegationId,
          spaceId: plan.spaceId,
          userId: plan.userId,
          runId: dispatch.runId,
          actingBotId: dispatch.memberId,
          status: "accepted",
        },
      });
      const card = TaskCardSchema.safeParse(row?.card).data;
      if (!row || !card?.artifacts.length || !row.runId) return undefined;
      const run = await tx.run.findFirst({
        where: { id: row.runId, status: "completed", cancelRequestedAt: null },
      });
      const group = await tx.chatGroup.findFirst({
        where: {
          id: plan.groupId,
          spaceId: plan.spaceId,
          userId: plan.userId,
          archivedAt: null,
          coordinatorBotId: input.chiefBotId,
          members: { some: { botId: row.actingBotId } },
        },
      });
      if (
        !run ||
        !group ||
        (await tx.externalEffect.findFirst({
          where: { runId: row.runId, status: { in: ["intended", "approved", "uncertain"] } },
        }))
      )
        return undefined;
      const artifact = await tx.artifact.findFirst({
        where: {
          id: { in: card.artifacts },
          runId: row.runId,
          botId: row.actingBotId,
          spaceId: plan.spaceId,
          userId: plan.userId,
          OR: [{ groupId: null }, { groupId: plan.groupId }],
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      });
      if (!artifact) return undefined;
      const nonce = `chief-result:${plan.sourceMessageId}:${plan.revision}`;
      if (
        await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: plan.threadId, clientNonce: nonce } },
        })
      )
        return { published: true as const };
      const result = chiefResult({
        requestMessageId: plan.sourceMessageId,
        revision: plan.revision,
        artifactId: artifact.id,
        href: `artifact:${encodeURIComponent(artifact.id)}`,
      })!;
      const blocks: MessageBlock[] = [
        {
          kind: "chief_result",
          result,
          name: artifact.name,
          mimeType: artifact.mimeType,
          botId: row.actingBotId,
          ...(artifact.groupId ? { groupId: artifact.groupId } : {}),
        },
      ];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: plan.threadId,
        role: "bot",
        origin: "system",
        botId: plan.chiefBotId,
        blocks,
        clientNonce: nonce,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: plan.spaceId,
        threadId: plan.threadId,
        botId: plan.chiefBotId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", origin: "system", blocks },
      });
      return { published: true as const, event };
    }),
  );
}
