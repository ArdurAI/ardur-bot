import type { MessageBlock, MessageOrigin } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "./client.js";

/** Group turns use channel inputs and their own outputs, never private thread history. */
export function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  limit: number,
  channelId?: string,
) {
  return prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      seq: true,
      role: true,
      runId: true,
      botId: true,
      blocks: true,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: { id: true, threadId: true, role: true, blocks: true } },
    },
  });
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  origin?: MessageOrigin;
  actorId?: string;
  blocks: MessageBlock[];
  botId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
  /**
   * The place the run's streamed reply held, read by the caller before the run left
   * `running` (leaving it releases the place). The run's final message fills it even
   * when it carries no text.
   */
  heldReplySeq?: number | null;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return prisma.$transaction((tx: Prisma.TransactionClient) =>
    createThreadMessageInTransaction(tx, input),
  );
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  // A bot message that saves text its run already showed fills the place held when that
  // text first appeared, so it stays above anything the owner sent meanwhile.
  const fillsReplyPlace =
    Boolean(input.runId) &&
    input.role === "bot" &&
    (input.heldReplySeq != null || input.blocks.some((block) => block.kind === "text"));
  if (fillsReplyPlace) {
    // The thread row orders every seq allocation. Lock it before reading the run's hold,
    // so two messages of one run cannot both take the place.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  }
  const run = fillsReplyPlace ? await assertRunCanWriteHistory(tx, input.runId) : undefined;
  const runHold = run && run.threadId === input.threadId ? run.replySeq : null;
  const heldSeq = input.heldReplySeq ?? runHold;
  if (input.runId && runHold !== null && runHold === heldSeq) {
    await tx.run.update({ where: { id: input.runId }, data: { replySeq: null } });
  }
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      ...(heldSeq === null ? { nextMessageSeq: { increment: 1 } } : {}),
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  if (!fillsReplyPlace) await assertRunCanWriteHistory(tx, input.runId);
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: heldSeq ?? thread.nextMessageSeq - 1,
      role: input.role,
      origin: input.origin ?? "system",
      actorId: input.actorId,
      blocks: input.blocks as Prisma.InputJsonValue,
      botId: input.botId,
      replyToMessageId: input.replyToMessageId,
      replyQuote: input.replyQuote,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<
  | {
      threadId: string;
      status: string;
      startedAt: Date | null;
      originDeviceGrantId: string | null;
      remoteRootTaskId: string | null;
      delegationId: string | null;
      delegationRootTaskId: string | null;
      replySeq: number | null;
    }
  | undefined
> {
  if (!runId) return;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: {
      threadId: true,
      status: true,
      startedAt: true,
      originDeviceGrantId: true,
      remoteRootTaskId: true,
      delegationId: true,
      delegationRootTaskId: true,
      replySeq: true,
    },
  });
  if (!run || run.status === "cancelled") {
    throw new RunHistoryWriteError();
  }
  return run;
}
