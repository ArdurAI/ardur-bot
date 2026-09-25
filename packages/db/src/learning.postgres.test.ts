import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
describePostgres("learning deletion protection (PostgreSQL)", () => {
  const id = `learning-fixture-${Date.now()}`;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: {
        id,
        name: "Learning fixture",
        slug: id,
        createdAt: new Date(),
        spaces: { create: { id, name: "Learning fixture" } },
      },
    });
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.organization.deleteMany({ where: { id } });
    await db.prisma.reviewExecution.deleteMany({ where: { spaceId: id } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it.each(["clear", "delete"] as const)(
    "purges derived bodies on %s and keeps only the audit tombstone",
    async (operation) => {
      const threadId = `${id}-${operation}`;
      const prisma = db.prisma;
      const bot = await prisma.bot.create({
        data: { spaceId: id, userId: "fixture-user", name: "Learning fixture", color: "ink" },
      });
      await prisma.thread.create({
        data: { id: threadId, spaceId: id, userId: "fixture-user", botId: bot.id },
      });
      const common = {
        spaceId: id,
        userId: "fixture-user",
        runId: "fixture-run",
        threadId,
        historyGeneration: 0,
      };
      await prisma.learningProposal.create({
        data: {
          ...common,
          botId: bot.id,
          fingerprint: "fixture",
          body: { proposedContent: "Use numbered steps." },
          expiresAt: new Date(),
        },
      });
      await prisma.proposalEvidence.create({
        data: { ...common, id: threadId, body: { excerpt: "Use numbered steps." } },
      });
      await prisma.reviewExecution.create({
        data: {
          ...common,
          idempotencyKey: threadId,
          botId: bot.id,
          evidenceWatermark: "fixture",
          policyVersion: "1",
          status: "proposed",
          reviewerPin: {},
          proposalIds: ["fixture"],
        },
      });
      await prisma.steeringSummary.create({
        data: {
          spaceId: id,
          threadId,
          runId: "fixture-run",
          messageId: "fixture-message",
          origin: "human-typed",
          actorId: "fixture-user",
          kind: "other",
        },
      });
      // Consumed queue rows can disappear without taking the durable summary with them.
      await prisma.steeringMessage.deleteMany({ where: { runId: "fixture-run" } });
      expect(await prisma.steeringSummary.count({ where: { threadId } })).toBe(1);
      if (operation === "clear")
        await prisma.thread.update({
          where: { id: threadId },
          data: { historyCompactionGeneration: { increment: 1 } },
        });
      else await prisma.thread.delete({ where: { id: threadId } });
      expect(await prisma.learningProposal.count({ where: { threadId } })).toBe(0);
      expect(await prisma.proposalEvidence.count({ where: { threadId } })).toBe(0);
      expect(await prisma.steeringSummary.count({ where: { threadId } })).toBe(0);
      const audit = await prisma.reviewExecution.findUniqueOrThrow({
        where: { idempotencyKey: threadId },
      });
      expect(audit).toMatchObject({
        status: "skipped",
        proposalIds: [],
        reason: "The source history was removed.",
      });
      if (operation === "delete") expect(audit.threadId).toBeNull();
    },
  );
});
