import { createHash } from "node:crypto";
import type { MessageBlock, ProposalEvidence } from "@ardurbot/contracts";
import type { LearningSignalRecords } from "@ardurbot/core";
import { buildLearningSignals } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";

export const LEARNING_POLICY_VERSION = "1";
export function learningHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Selects exact source records. Raw tool results, peer prose and summaries have no channel here. */
export async function loadLearningRecords(prisma: PrismaClient, runId: string) {
  const run = await prisma.run.findUnique({ where: { id: runId }, include: { thread: true } });
  if (!run || !["completed", "failed", "cancelled"].includes(run.status)) return null;
  const where = { runId: run.id, spaceId: run.spaceId, threadId: run.threadId };
  const [feedback, steering, events, usage, effects] = await Promise.all([
    prisma.feedback.findMany({ where, orderBy: { id: "asc" }, take: 100 }),
    prisma.steeringSummary.findMany({ where, orderBy: { id: "asc" }, take: 100 }),
    prisma.event.findMany({
      where: {
        ...where,
        type: { in: ["run.failed", "run.cancelled", "agent.tool.completed", "effect.denied"] },
      },
      orderBy: { seq: "asc" },
      take: 300,
    }),
    prisma.usageRecord.findMany({ where: { runId: run.id, spaceId: run.spaceId }, take: 100 }),
    prisma.externalEffect.findMany({
      where: { runId: run.id, spaceId: run.spaceId, status: "denied" },
      select: { id: true },
      take: 100,
    }),
  ]);
  const messages = await prisma.message.findMany({
    where: {
      threadId: run.threadId,
      id: {
        in: [run.sourceMessageId, ...steering.map((item) => item.messageId)].filter(
          (id): id is string => !!id,
        ),
      },
    },
    orderBy: { seq: "asc" },
    take: 100,
  });
  const outcomes: LearningSignalRecords["outcomes"] = [];
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "run.failed")
      outcomes.push({
        id: event.id,
        eventIds: [event.id],
        sourceClass: "run",
        outcome: {
          category: "failure",
          classification: payload.runtimeProblem
            ? "pin"
            : payload.providerErrorKind
              ? "provider"
              : "execution",
        },
      });
    if (event.type === "run.cancelled")
      outcomes.push({
        id: event.id,
        eventIds: [event.id],
        sourceClass: "run",
        outcome: {
          category: "cancellation",
          classification: payload.source === "human" ? "human" : "cancelled",
        },
      });
    if (event.type === "agent.tool.completed" && payload.outcome === "error")
      outcomes.push({
        id: event.id,
        eventIds: [event.id],
        sourceClass: "tool",
        outcome: { category: "tool-error", classification: "execution" },
      });
    if (event.type === "effect.denied")
      outcomes.push({
        id: event.id,
        eventIds: [event.id],
        sourceClass: "approval",
        outcome: { category: "denial", classification: "unknown" },
      });
  }
  for (const effect of effects)
    outcomes.push({
      id: effect.id,
      sourceClass: "approval",
      outcome: { category: "denial", classification: "human" },
    });
  for (const record of usage)
    outcomes.push({
      id: record.id,
      sourceClass: "usage",
      outcome: {
        category: "tokens",
        classification: "runtime",
        value: record.inputTokens + record.outputTokens,
      },
    });
  if (run.startedAt && run.completedAt)
    outcomes.push({
      id: `timing:${run.id}`,
      sourceClass: "run",
      outcome: {
        category: "timing",
        classification: "runtime",
        value: Math.max(0, run.completedAt.getTime() - run.startedAt.getTime()),
      },
    });
  const records: LearningSignalRecords = {
    runId,
    threadId: run.threadId,
    userId: run.userId,
    feedback,
    outcomes,
    messages: messages.map((message) => ({
      id: message.id,
      origin: message.origin,
      actorId: message.actorId,
      blocks: message.blocks as MessageBlock[],
      steeringKind: steering.find((item) => item.messageId === message.id)?.kind as
        | "correction"
        | "added-requirement"
        | "other"
        | undefined,
    })),
  };
  // Include edit/retract times so a queued review of replaced feedback cannot persist.
  const watermark = learningHash({ generation: run.thread.historyCompactionGeneration, records });
  return { run, records, watermark };
}
export function reviewEvidence(
  records: LearningSignalRecords,
  knownSecrets: readonly string[],
): ProposalEvidence[] {
  const channels = buildLearningSignals(records, knownSecrets);
  return [...channels.authorisedIntent, ...channels.observedOutcomes].slice(0, 60).map((item) => ({
    ...item,
    id: learningHash([records.runId, item]),
  }));
}
