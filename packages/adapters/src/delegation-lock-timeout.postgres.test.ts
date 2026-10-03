import type { JobPublisher } from "@ardurbot/adapter-kit";
import {
  createDb,
  createThreadEvents,
  goalBotAuthorityFingerprint,
  type PrismaClient,
} from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageBot } from "./bot-messages.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/**
 * Regression for the flaky bot-comms receipt e2e: admission transactions take the
 * delegation-root lock while the recipient's turn may still hold it, so under load
 * they outlive Prisma's default 5 s interactive-transaction cap. A slow pin resolver
 * stands in for that wait; the admission must still commit and queue the run.
 */
describePostgres("delegation admission transaction budget (PostgreSQL)", () => {
  const scopeId = `admission-timeout-${process.pid}-${Date.now()}`;
  const userId = `${scopeId}-user`;
  const organizationId = `${scopeId}-organization`;
  const spaceId = `${scopeId}-space`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await prisma.user.create({
      data: { id: userId, name: "Fixture owner", email: `${scopeId}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Fixture organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Fixture space", createdByUserId: userId },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("commits a peer-message admission whose in-transaction pin resolution outlives the default 5 s cap", {
    timeout: 90_000,
  }, async () => {
    const coordinator = await prisma.bot.create({
      data: { spaceId, userId, name: "Coordinator", color: "ink" },
    });
    const worker = await prisma.bot.create({
      data: { spaceId, userId, name: "Worker", color: "ink" },
    });
    await prisma.thread.create({ data: { spaceId, userId, botId: worker.id } });
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Fixture room", coordinatorBotId: coordinator.id },
    });
    const room = await prisma.thread.create({
      data: { spaceId, userId, groupId: group.id },
    });
    await prisma.chatGroupMember.createMany({
      data: [
        { groupId: group.id, botId: coordinator.id },
        { groupId: group.id, botId: worker.id },
      ],
    });
    const rootTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinator.id,
        threadId: room.id,
        prompt: "Coordinate the fixture",
        status: "completed",
      },
    });
    const untilAt = new Date(Date.now() + 3_600_000);
    await prisma.delegationRoot.create({
      data: {
        rootTaskId: rootTask.id,
        spaceId,
        userId,
        coordinatorBotId: coordinator.id,
        coordinatorThreadId: room.id,
        deadlineAt: untilAt,
        activeDescendants: 1,
      },
    });
    const goal = await prisma.teamGoal.create({
      data: {
        spaceId,
        userId,
        groupId: group.id,
        threadId: room.id,
        coordinatorBotId: coordinator.id,
        rootTaskId: rootTask.id,
        objective: "Finish the fixture",
        tokenLimit: 100_000,
        perWorkerTokens: 40_000,
        maxConcurrent: 2,
        maxDescendants: 10,
        untilAt,
      },
    });
    const pin = {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "fixture",
      effort: "off",
      credentialId: "fixture",
      revision: 0,
    };
    const coordinatorRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinator.id,
        threadId: room.id,
        taskId: rootTask.id,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: rootTask.id,
        runtimePin: pin,
        peerAuthorityFingerprint: await prisma.$transaction((tx) =>
          goalBotAuthorityFingerprint(tx, {
            spaceId,
            userId,
            goalId: goal.id,
            rootTaskId: rootTask.id,
            botId: coordinator.id,
          }),
        ),
        leaseOwner: "fixture-active",
        leaseFence: 1,
        leaseExpiresAt: untilAt,
      },
    });
    const enqueued: string[] = [];
    const jobs: JobPublisher = {
      enqueue: vi.fn(async (job) => {
        enqueued.push(String(job.payload.runId));
      }),
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs,
      // Controlled slow in-transaction work: resolution happens inside the admission
      // transaction, after the locks and before the delegation-root lock. Six seconds
      // exceeds Prisma's default 5 s interactive-transaction cap.
      resolveDelegationPin: async () => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return {
          kind: "resolved",
          pin,
          provider: "fixture",
          id: "fixture",
          thinkingLevel: "off",
        } as never;
      },
    };
    const deliveryKey = `slow-resolve:${goal.id}`;
    const sent = await messageBot(deps, coordinatorRun, coordinator, {
      bot_id: worker.id,
      message: "Prepare the draft for review.",
      intent: "request",
      card: {
        goal: "Prepare a draft",
        inputs: [{ type: "text", text: "Public fixture" }],
        doneWhen: ["Draft is ready"],
        deadlineAt: null,
      },
      deliveryKey,
    });
    expect(sent).toMatchObject({ ok: true });
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `bot-message:${deliveryKey}` },
    });
    expect(delivery.state).toBe("delivered");
    const child = await prisma.run.findFirstOrThrow({
      where: { delegationId: delivery.delegationId! },
    });
    expect(child.status).toBe("queued");
    expect(enqueued).toContain(child.id);
  });
});
