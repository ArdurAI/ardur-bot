import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { createDb, Prisma } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageSummary } from "./usage-summary.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const now = new Date("2026-09-24T12:00:00Z");
const scope = { spaceId: "usage-fixture-space", userId: "usage-fixture-member" };
const actor = { ...scope, email: "member@example.test", isDeploymentOwner: false } as Actor;
const coverage = {
  logicalInput: "complete",
  output: "complete",
  reasoning: "unknown",
  cacheReadInput: "complete",
  cacheWriteInput: "unknown",
  uncachedInput: "unknown",
};

describePostgres("scoped usage summaries (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    for (const id of [scope.userId, "usage-fixture-other"]) {
      await db.prisma.user.create({
        data: { id, name: "Fixture member", email: `${id}@example.test` },
      });
    }
    for (const id of [scope.spaceId, "usage-fixture-foreign-space"]) {
      await db.prisma.organization.create({
        data: {
          id,
          name: "Fixture space",
          slug: id,
          createdAt: now,
          spaces: { create: { id, name: "Fixture space" } },
        },
      });
    }
    await db.prisma.spaceMember.createMany({
      data: [
        { ...scope, organizationId: scope.spaceId, role: "member", createdAt: now },
        {
          ...scope,
          userId: "usage-fixture-other",
          organizationId: scope.spaceId,
          role: "member",
          createdAt: now,
        },
        {
          ...scope,
          spaceId: "usage-fixture-foreign-space",
          organizationId: "usage-fixture-foreign-space",
          role: "member",
          createdAt: now,
        },
      ].map((member, index) => ({ ...member, id: `usage-fixture-membership-${index}` })),
    });
    for (const [id, userId, spaceId] of [
      ["usage-fixture-bot", scope.userId, scope.spaceId],
      ["usage-fixture-second", scope.userId, scope.spaceId],
      ["usage-fixture-private", "usage-fixture-other", scope.spaceId],
      ["usage-fixture-foreign", scope.userId, "usage-fixture-foreign-space"],
    ]) {
      await db.prisma.bot.create({
        data: {
          id: id!,
          userId: userId!,
          spaceId: spaceId!,
          name: id!,
          color: "slate",
          thread: { create: { id: `${id}-thread`, userId: userId!, spaceId: spaceId! } },
        },
      });
    }
    const botId = "usage-fixture-bot";
    await db.prisma.task.create({
      data: {
        id: "usage-fixture-task",
        ...scope,
        botId,
        threadId: `${botId}-thread`,
        prompt: "Fixture task",
        status: "completed",
      },
    });
    await db.prisma.run.createMany({
      data: ["one", "two"].map((id) => ({
        id: `usage-fixture-run-${id}`,
        ...scope,
        botId,
        threadId: `${botId}-thread`,
        taskId: "usage-fixture-task",
        status: "completed",
        trigger: "user",
      })),
    });
    const record = (data: Partial<Prisma.UsageRecordUncheckedCreateInput>) =>
      db.prisma.usageRecord.create({
        data: {
          ...scope,
          botId,
          runId: "usage-fixture-run-one",
          provider: "paid",
          model: "fixture",
          createdAt: now,
          inputTokens: 120,
          outputTokens: 5,
          cacheReadInputTokens: 80,
          cacheWriteInputTokens: 15,
          categoryCoverage: coverage,
          reasoningSemantics: "subset-of-output",
          cost: 0.2,
          pricingProvenance: { kind: "request-observations" },
          ...data,
        },
      });
    // Several records and providers in the same run, spanning UTC days.
    await record({ createdAt: new Date("2026-09-23T23:59:59.999Z") });
    await record({ createdAt: new Date("2026-09-24T00:00:00Z") });
    await record({
      provider: "unknown",
      cost: null,
      pricingProvenance: Prisma.JsonNull,
      categoryCoverage: { ...coverage, output: "partial" },
    });
    // A single totals-only record combines model calls; no request count is inferred.
    await record({
      runId: "usage-fixture-run-two",
      inputTokens: 600,
      outputTokens: 40,
      categoryCoverage: Prisma.JsonNull,
      cost: 99,
      pricingProvenance: Prisma.JsonNull,
    });
    await record({
      botId: "usage-fixture-second",
      runId: null,
      cost: 0,
      pricingProvenance: { kind: "reported" },
      createdAt: new Date("2026-09-21T00:00:00Z"),
    });
    await record({
      runId: null,
      createdAt: new Date("2026-09-20T23:59:59.999Z"),
      inputTokens: 1,
      outputTokens: 1,
    });
    await record({
      runId: null,
      createdAt: new Date("2026-09-18T00:00:00Z"),
      inputTokens: 2,
      outputTokens: 2,
    });
    await record({
      runId: null,
      createdAt: new Date("2026-09-17T23:59:59.999Z"),
      inputTokens: 3,
      outputTokens: 3,
    });
    await record({
      runId: null,
      createdAt: new Date("2026-09-24T12:00:00.001Z"),
      inputTokens: 4,
      outputTokens: 4,
    });
    await record({
      botId: "usage-fixture-private",
      userId: "usage-fixture-other",
      runId: null,
      inputTokens: 999999,
      cost: 999999,
    });
    await record({
      botId: "usage-fixture-foreign",
      spaceId: "usage-fixture-foreign-space",
      runId: null,
      inputTokens: 999999,
      cost: 999999,
    });
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.space.deleteMany({
      where: { id: { in: [scope.spaceId, "usage-fixture-foreign-space"] } },
    });
    await db.prisma.organization.deleteMany({
      where: { id: { in: [scope.spaceId, "usage-fixture-foreign-space"] } },
    });
    await db.prisma.user.deleteMany({
      where: { id: { in: [scope.userId, "usage-fixture-other"] } },
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it("isolates members and spaces in totals, bot names, providers and pricing", async () => {
    const result = await usageSummary(db.prisma, actor, now);
    expect(result.records).toBe(9);
    expect(result.runCount).toBe(2);
    expect(result.runs).toBe(9);
    expect(result.inputTokens).toBe(120 * 4 + 600 + 1 + 2 + 3 + 4);
    expect(result.bots?.map((bot) => bot.botId)).toEqual([
      "usage-fixture-bot",
      "usage-fixture-second",
    ]);
    expect(JSON.stringify(result)).not.toContain("usage-fixture-private");
    expect(JSON.stringify(result)).not.toContain("usage-fixture-foreign");
    expect(JSON.stringify(result)).not.toContain("999999");
    const other = await usageSummary(db.prisma, { ...actor, userId: "usage-fixture-other" }, now);
    expect(other.records).toBe(1);
    expect(other.bots?.map((bot) => bot.botId)).toEqual(["usage-fixture-private"]);
  });
  it("counts distinct non-null run ids per period rather than summing records, providers or days", async () => {
    const result = await usageSummary(db.prisma, actor, now);
    expect(result.today).toMatchObject({
      records: 3,
      runs: 2,
      inputTokens: 840,
      outputTokens: 50,
      incomplete: true,
    });
    expect(result.week).toMatchObject({ records: 5, runs: 2, inputTokens: 1080, outputTokens: 60 });
    expect(result.bots?.find((bot) => bot.botId === "usage-fixture-bot")?.today.runs).toBe(2);
    expect(result.providers.find((row) => row.provider === "paid")?.week.runs).toBe(2);
    expect(result.providers.find((row) => row.provider === "unknown")?.week.runs).toBe(1);
    expect(result.bots?.find((bot) => bot.botId === "usage-fixture-second")?.week).toMatchObject({
      runs: 0,
      records: 1,
      cost: 0,
      costStatus: "complete",
    });
  });
  it("preserves provenance and known subtotals without pricing unpriced or incomplete tokens", async () => {
    const result = await usageSummary(db.prisma, actor, now);
    expect(result.today).toMatchObject({
      cost: null,
      knownCost: 0.2,
      costStatus: "partial",
      pricingProvenance: [{ kind: "request-observations" }],
    });
    expect(result.providers.find((row) => row.provider === "unknown")?.today).toMatchObject({
      cost: null,
      knownCost: null,
      costStatus: "unknown",
      incomplete: true,
    });
    expect(result.providers.find((row) => row.provider === "paid")?.today).toMatchObject({
      inputTokens: 720,
      outputTokens: 45,
      cost: null,
      knownCost: 0.2,
      costStatus: "partial",
      incomplete: false,
    });
    expect(result.week?.knownCost).toBeCloseTo(0.4);
  });
  it("honors inclusive UTC boundaries and excludes older and future records from recent groups", async () => {
    const result = await usageSummary(db.prisma, actor, now);
    expect(result.dayStart).toBe("2026-09-24T00:00:00.000Z");
    expect(result.weekStart).toBe("2026-09-21T00:00:00.000Z");
    expect(
      result.providers.find((row) => row.provider === "paid")?.daily.map((row) => row.records),
    ).toEqual([1, 0, 1, 1, 0, 1, 2]);
    const monday = await usageSummary(db.prisma, actor, new Date("2026-09-21T00:00:00Z"));
    expect(monday.today).toMatchObject({ records: 1, runs: 0 });
    expect(monday.week).toMatchObject({ records: 1, runs: 0 });
  });
  it("keeps UTC daily buckets when the database session uses another timezone", async () => {
    const result = await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Honolulu'`;
      return usageSummary(tx as unknown as PrismaClient, actor, now);
    });
    expect(result.today).toMatchObject({ records: 3, runs: 2 });
    expect(
      result.providers.find((row) => row.provider === "paid")?.daily.map((row) => row.records),
    ).toEqual([1, 0, 1, 1, 0, 1, 2]);
  });
  it("marks missing totals and separate reasoning incomplete while omitted cache splits stay complete", async () => {
    for (const [categoryCoverage, reasoningSemantics, incomplete] of [
      [coverage, "subset-of-output", false],
      [coverage, "separate", true],
      [{ ...coverage, logicalInput: "unknown" }, "unknown", true],
      [{ logicalInput: "complete" }, "unknown", true],
    ] as const) {
      const record = await db.prisma.usageRecord.create({
        data: {
          ...scope,
          botId: "usage-fixture-bot",
          runId: null,
          provider: "coverage-fixture",
          model: "fixture",
          inputTokens: 120,
          outputTokens: 1,
          categoryCoverage,
          reasoningSemantics,
          createdAt: now,
        },
      });
      try {
        const provider = (await usageSummary(db.prisma, actor, now)).providers.find(
          (row) => row.provider === "coverage-fixture",
        );
        expect(provider?.today).toMatchObject({
          records: 1,
          runs: 0,
          inputTokens: 120,
          outputTokens: 1,
          incomplete,
        });
      } finally {
        await db.prisma.usageRecord.delete({ where: { id: record.id } });
      }
    }
  });
  it("retains usage and resolves its name after bot deletion without inventing lost run identity", async () => {
    await db.prisma.botDeletion.create({
      data: {
        id: "usage-fixture-second",
        spaceId: scope.spaceId,
        name: "Deleted fixture",
        deletedByUserId: scope.userId,
        memoriesPreserved: false,
      },
    });
    await db.prisma.bot.delete({ where: { id: "usage-fixture-second" } });
    const result = await usageSummary(db.prisma, actor, now);
    expect(result.bots?.find((bot) => bot.botId === "usage-fixture-second")).toMatchObject({
      name: "Deleted fixture",
      week: { records: 1, runs: 0, cost: 0 },
    });
    await db.prisma.usageRecord.create({
      data: {
        ...scope,
        botId: null,
        runId: null,
        provider: "local",
        model: "fixture",
        inputTokens: 3,
        outputTokens: 2,
        createdAt: now,
      },
    });
    expect(
      (await usageSummary(db.prisma, actor, now)).bots?.find((bot) => bot.botId === null),
    ).toMatchObject({ name: null, today: { records: 1, runs: 0, cost: null } });
  });
});
