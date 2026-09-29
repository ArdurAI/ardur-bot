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
   * A run's final message passes this so tool-only completions still fill the place
   * their streaming reserved; bot messages carrying reply text consume it regardless.
   */
  consumeReservedReplySeq?: boolean;
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
  const run = await assertRunCanWriteHistory(tx, input.runId);
  // A bot message that saves text the run already showed fills the place reserved when
  // that text first appeared, so it stays above anything the owner sent meanwhile.
  const reservedSeq =
    input.runId &&
    input.role === "bot" &&
    run?.replySeq != null &&
    (input.consumeReservedReplySeq === true || input.blocks.some((block) => block.kind === "text"))
      ? run.replySeq
      : null;
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: {
      ...(reservedSeq === null ? { nextMessageSeq: { increment: 1 } } : {}),
      unread: (input.markUnread ?? input.role === "bot") ? true : undefined,
    },
    select: { nextMessageSeq: true },
  });
  if (reservedSeq !== null && input.runId) {
    await tx.run.update({ where: { id: input.runId }, data: { replySeq: null } });
  }
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: reservedSeq ?? thread.nextMessageSeq - 1,
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

/**
 * Hold the thread position of a run's reply while its text streams. The first visible
 * text is already on the owner's screen, so anything sent after it must land below the
 * reply once the reply is saved. Idempotent: one place per streamed draft, and a
 * concurrent reservation keeps the earlier place. Consumed by the bot message that
 * saves the text; discarded if the draft is thrown away (pause, terminal cleanup).
 */
export async function reserveRunReplySeqInTransaction(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string; currentReplySeq?: number | null },
): Promise<void> {
  const current =
    input.currentReplySeq !== undefined
      ? input.currentReplySeq
      : ((
          await tx.run.findUnique({
            where: { id: input.runId },
            select: { replySeq: true },
          })
        )?.replySeq ?? null);
  if (current !== null) return;
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextMessageSeq: { increment: 1 } },
    select: { nextMessageSeq: true },
  });
  await tx.run.updateMany({
    where: { id: input.runId, replySeq: null },
    data: { replySeq: thread.nextMessageSeq - 1 },
  });
}

/** Drop a reply reservation whose streamed draft is no longer part of the transcript. */
export async function discardRunReplySeqInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> {
  await tx.run.updateMany({
    where: { id: runId, replySeq: { not: null } },
    data: { replySeq: null },
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
