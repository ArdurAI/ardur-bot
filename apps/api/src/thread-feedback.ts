import type { Actor, MessageReaction } from "@ardurbot/contracts";
import { FeedbackReasonSchema } from "@ardurbot/contracts";
import { redactLearningText } from "@ardurbot/core";
import type { Prisma } from "@ardurbot/db";
import { appendEventInTransaction, IsolationError } from "@ardurbot/db";

/** Called under the thread lock; no task, message, or run is created. */
export async function recordThreadFeedback(
  tx: Prisma.TransactionClient,
  actor: Actor,
  threadId: string,
  input: { messageId: string; reaction: MessageReaction; reason?: string; retract?: boolean },
) {
  const parent = await tx.message.findFirst({
    where: { id: input.messageId, threadId, role: "bot" },
    select: { id: true, runId: true, botId: true },
  });
  if (!parent?.runId) throw new IsolationError();
  const run = await tx.run.findFirst({
    where: { id: parent.runId, threadId, spaceId: actor.spaceId },
    select: { id: true, botId: true },
  });
  if (!run) throw new IsolationError();
  const reason =
    input.reason === undefined
      ? undefined
      : redactLearningText(FeedbackReasonSchema.parse(input.reason)) || null;
  const existing = await tx.feedback.findUnique({
    where: { messageId_actorId: { messageId: parent.id, actorId: actor.userId } },
  });
  const data = {
    rating: input.reaction === "👍" ? "positive" : "negative",
    ...(reason !== undefined
      ? { reason }
      : existing?.rating !== (input.reaction === "👍" ? "positive" : "negative")
        ? { reason: null }
        : {}),
    retractedAt: input.retract ? new Date() : null,
  };
  if (
    existing &&
    existing.rating === data.rating &&
    (reason === undefined || existing.reason === reason) &&
    Boolean(existing.retractedAt) === Boolean(input.retract)
  )
    return { eventSeq: null, feedbackRunId: run.id };
  const feedback = await tx.feedback.upsert({
    where: { messageId_actorId: { messageId: parent.id, actorId: actor.userId } },
    create: {
      ...data,
      spaceId: actor.spaceId,
      threadId,
      messageId: parent.id,
      runId: run.id,
      actorId: actor.userId,
    },
    update: data,
  });
  // Replaced intent must not leave an actionable proposal based on the earlier feedback.
  await tx.learningProposal.updateMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, runId: run.id, status: "pending" },
    data: { status: "superseded" },
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: actor.spaceId,
    threadId,
    botId: run.botId,
    type: "thread.message.reaction",
    // Feedback after cancellation is still valid; the event's target lives in the typed record.
    payload: {
      messageId: parent.id,
      feedback: {
        id: feedback.id,
        actorId: feedback.actorId,
        messageId: parent.id,
        runId: run.id,
        rating: feedback.rating,
        reason: feedback.reason,
        retractedAt: feedback.retractedAt?.toISOString() ?? null,
        updatedAt: feedback.updatedAt.toISOString(),
      },
    },
  });
  return { eventSeq: event.seq, feedbackRunId: run.id };
}
