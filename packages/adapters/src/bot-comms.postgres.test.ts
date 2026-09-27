import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import { buildBotMessageWakePrompt } from "@ardurbot/core";
import {
  appendBotMessageWakeInTransaction,
  claimSteering,
  createDb,
  createThreadEvents,
  createThreadMessage,
  dispatchBotMessageWake,
  expireQuietBotMessages,
  finalizeRun,
  goalBotAuthorityFingerprint,
  type PrismaClient,
  refreshBoundBotMessageWakeRun,
} from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replyToBotDelivery } from "./bot-comms.js";
import { messageBot } from "./bot-messages.js";
import { createJobReconciler } from "./job-reconciler.js";
import { recordRunUsage } from "./run-usage.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("goal desk inbox (PostgreSQL)", () => {
  const scopeId = `peer-${process.pid}-${Date.now()}`;
  const userId = `${scopeId}-user`;
  const organizationId = `${scopeId}-organization`;
  const spaceId = `${scopeId}-space`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let fixtureNumber = 0;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await prisma.user.create({
      data: { id: userId, name: "Fixture owner", email: `${scopeId}@ardurbot.test` },
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

  async function fixture(mode: "idle" | "compatible" | "owner" | "held" = "idle") {
    const n = ++fixtureNumber;
    const coordinator = await prisma.bot.create({
      data: { spaceId, userId, name: `Coordinator ${n}`, color: "ink" },
    });
    const worker = await prisma.bot.create({
      data: { spaceId, userId, name: `Worker ${n}`, color: "ink" },
    });
    const workerThread = await prisma.thread.create({
      data: { spaceId, userId, botId: worker.id },
    });
    await prisma.thread.create({ data: { spaceId, userId, botId: coordinator.id } });
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: `Room ${n}`, coordinatorBotId: coordinator.id },
    });
    const room = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
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
        perWorkerTokens: 10_000,
        maxConcurrent: 2,
        maxDescendants: 10,
        untilAt,
      },
    });
    const coordinatorRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinator.id,
        threadId: room.id,
        taskId: rootTask.id,
        status: mode === "compatible" ? "running" : "completed",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: rootTask.id,
        ...(mode === "compatible"
          ? {
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
            }
          : {}),
      },
    });
    const delegation = await prisma.delegation.create({
      data: {
        rootTaskId: rootTask.id,
        parentRunId: coordinatorRun.id,
        spaceId,
        userId,
        requesterBotId: coordinator.id,
        actingBotId: worker.id,
        requesterName: coordinator.name,
        actingName: worker.name,
        kind: "message",
        depth: 1,
        hop: 1,
        status: "running",
        snapshot: {},
        authority: {},
        ancestorBotIds: [coordinator.id],
        reservedTokens: 0,
        deadlineAt: untilAt,
        admissionKey: `bot-message:${scopeId}:${n}`,
        fingerprint: `request-${n}`,
      },
    });
    const deliveryId = randomUUID();
    const outbound = await createThreadMessage(prisma, {
      threadId: room.id,
      role: "bot",
      botId: coordinator.id,
      blocks: [
        {
          kind: "bot_message_sent",
          toBotId: worker.id,
          toBotName: worker.name,
          text: "Check the fixture",
          intent: "request",
          delegationId: delegation.id,
          deliveryId,
          deliveryState: "delivered",
        },
      ],
      markUnread: false,
    });
    const inbound = await createThreadMessage(prisma, {
      threadId: workerThread.id,
      role: "user",
      origin: "peer-bot",
      actorId: coordinator.id,
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: coordinator.id,
          fromBotName: coordinator.name,
          text: "Check the fixture",
          intent: "request",
          delegationId: delegation.id,
          deliveryId,
          deliveryState: "delivered",
          hop: 1,
          returnToMessageId: outbound.id,
        },
      ],
      markUnread: false,
    });
    const workerTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: worker.id,
        threadId: workerThread.id,
        prompt: "Check the fixture",
        status: "running",
      },
    });
    const workerRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: worker.id,
        threadId: workerThread.id,
        taskId: workerTask.id,
        status: "running",
        trigger: "bot_message",
        sourceMessageId: inbound.id,
        goalId: goal.id,
        delegationId: delegation.id,
        delegationRootTaskId: rootTask.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
      },
    });
    await prisma.delegation.update({ where: { id: delegation.id }, data: { runId: workerRun.id } });
    const authorityFingerprint = await prisma.$transaction((tx) =>
      goalBotAuthorityFingerprint(tx, {
        spaceId,
        userId,
        goalId: goal.id,
        rootTaskId: rootTask.id,
        botId: worker.id,
      }),
    );
    const parent = await prisma.botMessageDelivery.create({
      data: {
        id: deliveryId,
        spaceId,
        userId,
        goalId: goal.id,
        rootTaskId: rootTask.id,
        conversationId: deliveryId,
        senderBotId: coordinator.id,
        recipientBotId: worker.id,
        senderThreadId: room.id,
        recipientThreadId: workerThread.id,
        sourceRunId: coordinatorRun.id,
        sourceGroupId: group.id,
        intent: "request",
        outboundMessageId: outbound.id,
        inboundMessageId: inbound.id,
        delegationId: delegation.id,
        state: "delivered",
        hop: 1,
        authorityFingerprint,
        requestFingerprint: "fixture-request",
        idempotencyKey: `fixture-parent:${deliveryId}`,
        expiresAt: untilAt,
        deliveredAt: new Date(),
      },
    });
    let activeRun: Awaited<ReturnType<typeof prisma.run.create>> | null = null;
    if (mode === "compatible") activeRun = coordinatorRun;
    else if (mode !== "idle") {
      const task = await prisma.task.create({
        data: {
          spaceId,
          userId,
          botId: coordinator.id,
          threadId: room.id,
          prompt: "Current turn",
          status: "running",
        },
      });
      activeRun = await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId: coordinator.id,
          threadId: room.id,
          taskId: task.id,
          status: mode === "held" ? "waiting_input" : "running",
          trigger: mode === "owner" ? "user" : "follow_up",
          ...(mode === "owner" ? {} : { goalId: goal.id, delegationRootTaskId: rootTask.id }),
          leaseOwner: "fixture-active",
          leaseFence: 1,
        },
      });
    }
    const enqueued: string[] = [];
    const jobs: JobPublisher = {
      enqueue: vi.fn(async (job) => {
        enqueued.push(String(job.payload.runId));
      }),
      cancel: async () => undefined,
      close: async () => undefined,
    };
    return {
      coordinator,
      worker,
      room,
      workerThread,
      goal,
      rootTask,
      parent,
      workerRun,
      coordinatorRun,
      activeRun,
      jobs,
      enqueued,
      deps: { prisma, events: createThreadEvents(prisma), jobs },
    };
  }

  it("stores one linked result and one idle wake across concurrent retries", async () => {
    const f = await fixture();
    const input = {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result" as const,
      deliveryKey: `reply-${f.parent.id}`,
    };
    const [first, second] = await Promise.all([
      replyToBotDelivery(f.deps, f.workerRun, f.worker, input),
      replyToBotDelivery(f.deps, f.workerRun, f.worker, input),
    ]);
    if (!first.ok) throw new Error(first.error);
    if (!second.ok) throw new Error(second.error);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first).toHaveProperty("deliveryId", second.ok ? second.deliveryId : undefined);
    const parent = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: f.parent.id },
    });
    expect(parent.state).toBe("replied");
    expect(parent.replyDeliveryId).toBeTruthy();
    expect(
      await prisma.botMessageDelivery.count({ where: { inReplyToDeliveryId: parent.id } }),
    ).toBe(1);
    expect(await prisma.botMessageWake.count({ where: { rootTaskId: f.rootTask.id } })).toBe(1);
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(1);
    expect(
      (await prisma.delegation.findUniqueOrThrow({ where: { id: f.parent.delegationId! } }))
        .coordinatorWokenAt,
    ).not.toBeNull();
  });

  it("steers only a compatible same-root coordinator turn", async () => {
    const f = await fixture("compatible");
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `reply-${f.parent.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ok).toBe(true);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    expect(wake).toMatchObject({ state: "bound", runId: f.activeRun!.id });
    expect(await prisma.steeringMessage.count({ where: { runId: f.activeRun!.id } })).toBe(1);
    const steering = await claimSteering(prisma, {
      threadId: f.room.id,
      botId: f.coordinator.id,
      runId: f.activeRun!.id,
      leaseOwner: "fixture-active",
      leaseFence: 1,
      seenIds: [],
    });
    expect(steering).toHaveLength(1);
    expect(steering[0]?.text).toContain("The fixture is complete.");
  });

  it("recovers a bound batch when its run finalizes before taking steering", async () => {
    const f = await fixture("compatible");
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `reply-${f.parent.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    const attempt = await prisma.attempt.create({
      data: { runId: f.activeRun!.id, fence: 1, status: "running" },
    });
    const finalized = await finalizeRun(prisma, {
      spaceId,
      threadId: f.room.id,
      botId: f.coordinator.id,
      runId: f.activeRun!.id,
      taskId: f.activeRun!.taskId,
      attemptId: attempt.id,
      leaseOwner: "fixture-active",
      leaseFence: 1,
      outcome: "completed",
      blocks: [],
    });
    expect(finalized).not.toBe(false);
    if (!finalized) throw new Error("Finalization lost its lease.");
    expect(finalized.continuationRunId).toBeNull();
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    expect(wake).toMatchObject({ state: "retry_wait", runId: null, attempts: 1 });
    expect(wake.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await dispatchBotMessageWake(prisma, wake.id)).toBeNull();
    await prisma.botMessageWake.update({
      where: { id: wake.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const rebound = await dispatchBotMessageWake(prisma, wake.id);
    expect(rebound).toBeTruthy();
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(1);
    await createJobReconciler({ prisma, jobs: f.jobs }, { batchSize: 100 }).reconcileOnce();
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(1);
    const retryRun = await prisma.run.update({
      where: { id: rebound! },
      data: { status: "running", leaseOwner: "fixture-retry", leaseFence: 1 },
    });
    const retryAttempt = await prisma.attempt.create({
      data: { runId: retryRun.id, fence: 1, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.room.id,
        botId: f.coordinator.id,
        runId: retryRun.id,
        taskId: retryRun.taskId,
        attemptId: retryAttempt.id,
        leaseOwner: "fixture-retry",
        leaseFence: 1,
        outcome: "completed",
        blocks: [],
      }),
    ).not.toBe(false);
    expect(await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } })).toMatchObject(
      { state: "consumed", attempts: 1 },
    );
  });

  it("replays claimed steering after a failed turn without a read receipt", async () => {
    const f = await fixture("compatible");
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `reply-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    expect(
      await claimSteering(prisma, {
        threadId: f.room.id,
        botId: f.coordinator.id,
        runId: f.activeRun!.id,
        leaseOwner: "fixture-active",
        leaseFence: 1,
        seenIds: [],
      }),
    ).toHaveLength(1);
    const attempt = await prisma.attempt.create({
      data: { runId: f.activeRun!.id, fence: 1, status: "running" },
    });
    const finalized = await finalizeRun(prisma, {
      spaceId,
      threadId: f.room.id,
      botId: f.coordinator.id,
      runId: f.activeRun!.id,
      taskId: f.activeRun!.taskId,
      attemptId: attempt.id,
      leaseOwner: "fixture-active",
      leaseFence: 1,
      outcome: "failed",
      error: "Runtime stopped before input acceptance.",
    });
    if (!finalized) throw new Error("Finalization lost its lease.");
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    expect(wake).toMatchObject({ state: "retry_wait", runId: null, generation: 2, attempts: 1 });
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({
      state: "delivered",
      failureCode: "read-unconfirmed",
    });
    expect(finalized.continuationRunId).toBeNull();
    await prisma.botMessageWake.update({
      where: { id: wake.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const rebound = await dispatchBotMessageWake(prisma, wake.id);
    expect(rebound).toBeTruthy();
    expect(
      (
        await prisma.task.findUniqueOrThrow({
          where: { id: (await prisma.run.findUniqueOrThrow({ where: { id: rebound! } })).taskId },
        })
      ).prompt,
    ).toContain("The fixture is complete.");
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(1);
  });

  it.each(["owner", "held"] as const)("leaves a %s turn untouched", async (mode) => {
    const f = await fixture(mode);
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `reply-${f.parent.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ok).toBe(true);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    expect(wake).toMatchObject({ state: "pending", runId: null });
    expect(await prisma.steeringMessage.count({ where: { runId: f.activeRun!.id } })).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.activeRun!.id } })).toMatchObject({
      status: mode === "held" ? "waiting_input" : "running",
    });
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    const nextRunId = await dispatchBotMessageWake(prisma, wake.id);
    expect(nextRunId).toBeTruthy();
  });

  it("repairs a committed reply after enqueue failure", async () => {
    const f = await fixture();
    const rejectedJobs: JobPublisher = {
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
      cancel: async () => undefined,
      close: async () => undefined,
    };
    const result = await replyToBotDelivery(
      { ...f.deps, jobs: rejectedJobs },
      f.workerRun,
      f.worker,
      {
        inReplyToDeliveryId: f.parent.id,
        message: "The fixture is complete.",
        intent: "result",
        deliveryKey: `reply-${f.parent.id}`,
      },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.ok).toBe(true);
    await createJobReconciler({ prisma, jobs: f.jobs }, { batchSize: 100 }).reconcileOnce();
    expect(f.enqueued.length).toBeGreaterThan(0);
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(1);
  });

  it("refuses a wrong parent and a second substantive reply", async () => {
    const f = await fixture();
    const another = await fixture();
    const wrong = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: another.parent.id,
      message: "Wrong request",
      intent: "result",
      deliveryKey: `wrong-${f.parent.id}`,
    });
    expect(wrong.ok).toBe(false);
    const first = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `reply-${f.parent.id}`,
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.ok).toBe(true);
    const second = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "A different answer",
      intent: "result",
      deliveryKey: `different-${f.parent.id}`,
    });
    expect(second.ok).toBe(false);
  });

  it("allows hop six but refuses a reply beyond it", async () => {
    const f = await fixture();
    await prisma.botMessageDelivery.update({ where: { id: f.parent.id }, data: { hop: 6 } });
    const denied = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Clarify the fixture",
      intent: "question",
      deliveryKey: `hop-denied-${f.parent.id}`,
    });
    expect(denied.ok).toBe(false);
    await prisma.botMessageDelivery.update({ where: { id: f.parent.id }, data: { hop: 5 } });
    const allowed = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Clarify the fixture",
      intent: "question",
      deliveryKey: `hop-allowed-${f.parent.id}`,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error(allowed.error);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: allowed.deliveryId } }),
    ).toMatchObject({
      hop: 6,
      intent: "question",
      inReplyToDeliveryId: f.parent.id,
    });
  });

  it.each(["owner", "held"] as const)("seals eight bodies behind a %s turn", async (mode) => {
    const f = await fixture(mode);
    const fingerprint = await prisma.$transaction((tx) =>
      goalBotAuthorityFingerprint(tx, {
        spaceId,
        userId,
        goalId: f.goal.id,
        rootTaskId: f.rootTask.id,
        botId: f.coordinator.id,
      }),
    );
    for (let index = 0; index < 9; index += 1) {
      const deliveryId = randomUUID();
      const inbound = await createThreadMessage(prisma, {
        threadId: f.room.id,
        role: "user",
        origin: "peer-bot",
        actorId: f.worker.id,
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: f.worker.id,
            fromBotName: f.worker.name,
            text: `Item ${index}`,
            intent: "question",
            deliveryId,
            deliveryState: "delivered",
          },
        ],
        markUnread: false,
      });
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${f.room.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${f.rootTask.id} FOR UPDATE`;
        const delivery = await tx.botMessageDelivery.create({
          data: {
            id: deliveryId,
            spaceId,
            userId,
            goalId: f.goal.id,
            rootTaskId: f.rootTask.id,
            conversationId: deliveryId,
            senderBotId: f.worker.id,
            recipientBotId: f.coordinator.id,
            senderThreadId: f.workerThread.id,
            recipientThreadId: f.room.id,
            sourceRunId: f.workerRun.id,
            intent: "question",
            outboundMessageId: f.parent.inboundMessageId!,
            inboundMessageId: inbound.id,
            state: "delivered",
            hop: 2,
            authorityFingerprint: fingerprint,
            requestFingerprint: `item-${index}`,
            idempotencyKey: `batch-${deliveryId}`,
            expiresAt: f.goal.untilAt,
            deliveredAt: new Date(),
          },
        });
        await appendBotMessageWakeInTransaction(
          tx,
          delivery,
          buildBotMessageWakePrompt({
            from: { id: f.worker.id, name: f.worker.name },
            text: `Item ${index}`,
            intent: "question",
          }).length,
        );
      });
    }
    const wakes = await prisma.botMessageWake.findMany({
      where: { rootTaskId: f.rootTask.id },
      orderBy: { generation: "asc" },
    });
    expect(wakes.map((wake) => [wake.generation, wake.deliveryIds.length, wake.state])).toEqual([
      [1, 8, "sealed"],
      [2, 1, "pending"],
    ]);
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: wakes[0]!.clientNonce },
      }),
    ).toBe(0);
    expect(await dispatchBotMessageWake(prisma, wakes[0]!.id)).toBeNull();
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    const rebound = await dispatchBotMessageWake(prisma, wakes[0]!.id);
    expect(rebound).toBeTruthy();
    const boundRun = await prisma.run.findUniqueOrThrow({ where: { id: rebound! } });
    const boundTask = await prisma.task.findUniqueOrThrow({ where: { id: boundRun.taskId } });
    expect(wakes[0]!.promptCharacters).toBe(boundTask.prompt.length);
    expect(wakes[1]!.promptCharacters).toBe(
      buildBotMessageWakePrompt({
        from: { id: f.worker.id, name: f.worker.name },
        text: "Item 8",
        intent: "question",
      }).length,
    );
  });

  it("refuses a full inbox and leaves one room chip", async () => {
    const f = await fixture();
    await prisma.botMessageDelivery.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        id: randomUUID(),
        spaceId,
        userId,
        goalId: f.goal.id,
        rootTaskId: f.rootTask.id,
        conversationId: `full-${f.parent.id}-${index}`,
        senderBotId: f.worker.id,
        recipientBotId: f.coordinator.id,
        senderThreadId: f.workerThread.id,
        recipientThreadId: f.room.id,
        sourceRunId: f.workerRun.id,
        intent: "question",
        outboundMessageId: f.parent.inboundMessageId!,
        inboundMessageId: f.parent.outboundMessageId,
        state: "delivered",
        hop: 2,
        authorityFingerprint: "fixture",
        requestFingerprint: `full-${index}`,
        idempotencyKey: `full-${f.parent.id}-${index}`,
        expiresAt: f.goal.untilAt,
        deliveredAt: new Date(),
      })),
    });
    for (let index = 0; index < 2; index += 1) {
      const refused = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
        inReplyToDeliveryId: f.parent.id,
        message: "The fixture is complete.",
        intent: "result",
        deliveryKey: `full-reply-${f.parent.id}-${index}`,
      });
      expect(refused).toMatchObject({ ok: false, error: "Inbox full" });
    }
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: f.parent.id } }),
    ).toMatchObject({
      state: "delivered",
      replyDeliveryId: null,
    });
    expect(
      await prisma.message.count({
        where: { threadId: f.room.id, clientNonce: `goal-inbox-full:${f.goal.id}` },
      }),
    ).toBe(1);
  });

  it("persists status and FYI without scheduling work", async () => {
    const f = await fixture();
    await prisma.run.update({ where: { id: f.coordinatorRun.id }, data: { status: "running" } });
    for (const intent of ["status", "fyi"] as const) {
      const result = await messageBot(f.deps, f.coordinatorRun, f.coordinator, {
        bot_id: f.worker.id,
        intent,
        message: `${intent} fixture`,
        deliveryKey: `${intent}-${f.parent.id}`,
      });
      expect(result.ok).toBe(true);
    }
    expect(
      await prisma.botMessageDelivery.count({
        where: { rootTaskId: f.rootTask.id, intent: { in: ["status", "fyi"] } },
      }),
    ).toBe(2);
    expect(await prisma.botMessageWake.count({ where: { rootTaskId: f.rootTask.id } })).toBe(0);
  });

  it("updates late usage on the delivery without scheduling another wake", async () => {
    const f = await fixture();
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `reply-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const before = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: reply.deliveryId },
    });
    const wakeCount = await prisma.botMessageWake.count({ where: { rootTaskId: f.rootTask.id } });
    expect(before.tokens).toBeNull();
    await recordRunUsage({ prisma, events: createThreadEvents(prisma) }, f.workerRun, {
      provider: "fixture",
      model: "fixture",
      inputTokens: 11,
      outputTokens: 4,
    });
    const after = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: reply.deliveryId },
    });
    expect(after.tokens).toBe(15);
    expect(after.cost).toBeNull();
    expect(await prisma.botMessageWake.count({ where: { rootTaskId: f.rootTask.id } })).toBe(
      wakeCount,
    );
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(1);
  });

  it("settles an archived recipient and still reconciles unrelated queued work", async () => {
    const f = await fixture("owner");
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "A pending answer",
      intent: "result",
      deliveryKey: `archived-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    const other = await fixture();
    const queued = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: other.coordinator.id,
        threadId: other.room.id,
        taskId: other.rootTask.id,
        status: "queued",
        trigger: "follow_up",
      },
    });
    await prisma.bot.update({ where: { id: f.coordinator.id }, data: { archivedAt: new Date() } });
    const reconciler = createJobReconciler({ prisma, jobs: f.jobs }, { batchSize: 100 });
    await reconciler.reconcileOnce();
    expect(await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } })).toMatchObject(
      { state: "cancelled" },
    );
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ state: "failed", failureCode: "recipient-unavailable" });
    expect(f.enqueued).toContain(queued.id);
    await reconciler.reconcileOnce();
    expect(
      await prisma.message.count({
        where: { threadId: f.room.id, clientNonce: `peer-wake-failure:${wake.id}` },
      }),
    ).toBe(1);
  });

  it("makes a permanent runtime problem terminal without another run", async () => {
    const f = await fixture();
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "A final answer",
      intent: "result",
      deliveryKey: `permanent-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    const run = await prisma.run.update({
      where: { id: wake.runId! },
      data: { status: "running", leaseOwner: "fixture-wake", leaseFence: 1 },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const finalized = await finalizeRun(prisma, {
      spaceId,
      threadId: f.room.id,
      botId: f.coordinator.id,
      runId: run.id,
      taskId: run.taskId,
      attemptId: attempt.id,
      leaseOwner: "fixture-wake",
      leaseFence: 1,
      outcome: "failed",
      error: "Connection unavailable",
      runtimeProblem: {
        kind: "problem",
        code: "runtime-unavailable",
        pin: {
          runtimeKind: "pi",
          provider: null,
          modelId: null,
          effort: null,
          credentialId: null,
          revision: 0,
        },
        reason: "Connection unavailable",
        actions: [],
      },
    });
    if (!finalized) throw new Error("Finalization lost its lease.");
    expect(finalized.continuationRunId).toBeNull();
    expect(await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } })).toMatchObject(
      { state: "failed" },
    );
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ state: "failed", failureCode: "runtime-unavailable" });
    expect(
      await prisma.run.count({ where: { clientNonce: { startsWith: `peer-wake:${wake.id}:` } } }),
    ).toBe(1);
    expect(
      await prisma.message.count({
        where: { threadId: f.room.id, clientNonce: `peer-wake-failure:${wake.id}` },
      }),
    ).toBe(1);
  });

  it("bounds interrupted wake retries to three delayed rebinds", async () => {
    const f = await fixture();
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Retry this answer",
      intent: "result",
      deliveryKey: `bounded-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: reply.deliveryId } },
    });
    let runId = wake.runId!;
    for (const [index, delay] of [30_000, 120_000, 300_000, 0].entries()) {
      const run = await prisma.run.update({
        where: { id: runId },
        data: { status: "running", leaseOwner: "fixture-interrupted", leaseFence: 1 },
      });
      const attempt = await prisma.attempt.create({
        data: { runId, fence: 1, status: "running" },
      });
      expect(
        await finalizeRun(prisma, {
          spaceId,
          threadId: f.room.id,
          botId: f.coordinator.id,
          runId,
          taskId: run.taskId,
          attemptId: attempt.id,
          leaseOwner: "fixture-interrupted",
          leaseFence: 1,
          outcome: "failed",
          error: "Interrupted before input acceptance",
        }),
      ).not.toBe(false);
      const updated = await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } });
      if (index === 3) {
        expect(updated).toMatchObject({ state: "failed", attempts: 3 });
        break;
      }
      expect(updated).toMatchObject({ state: "retry_wait", attempts: index + 1 });
      expect(updated.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(delay - 5_000);
      expect(await dispatchBotMessageWake(prisma, wake.id)).toBeNull();
      await prisma.botMessageWake.update({
        where: { id: wake.id },
        data: { nextAttemptAt: new Date(0) },
      });
      runId = (await dispatchBotMessageWake(prisma, wake.id))!;
      expect(runId).toBeTruthy();
    }
    expect(
      await prisma.run.count({ where: { clientNonce: { startsWith: `peer-wake:${wake.id}:` } } }),
    ).toBe(4);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ state: "failed", failureCode: "retry-exhausted" });
    expect(
      await prisma.message.count({
        where: { threadId: f.room.id, clientNonce: `peer-wake-failure:${wake.id}` },
      }),
    ).toBe(1);
  });

  it("keeps a clarification separate from the final result slot", async () => {
    const f = await fixture("owner");
    const question = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Which format?",
      intent: "question",
      deliveryKey: `question-${f.parent.id}`,
    });
    if (!question.ok) throw new Error(question.error);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: f.parent.id } }),
    ).toMatchObject({ state: "delivered", replyDeliveryId: null });
    expect(
      (await prisma.delegation.findUniqueOrThrow({ where: { id: f.parent.delegationId! } }))
        .coordinatorWokenAt,
    ).toBeNull();
    const questionWake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: question.deliveryId } },
    });
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    const questionRunId = await dispatchBotMessageWake(prisma, questionWake.id);
    expect(questionRunId).toBeTruthy();
    const questionRun = await prisma.run.update({
      where: { id: questionRunId! },
      data: { status: "running", leaseOwner: "fixture-question", leaseFence: 1 },
    });
    const questionAttempt = await prisma.attempt.create({
      data: { runId: questionRun.id, fence: 1, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.room.id,
        botId: f.coordinator.id,
        runId: questionRun.id,
        taskId: questionRun.taskId,
        attemptId: questionAttempt.id,
        leaseOwner: "fixture-question",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Use the short format" }],
      }),
    ).not.toBe(false);
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Final format ready",
      intent: "result",
      deliveryKey: `result-${f.parent.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: f.parent.id } }),
    ).toMatchObject({ state: "replied", replyDeliveryId: result.deliveryId });
    const wakes = await prisma.botMessageWake.findMany({ where: { rootTaskId: f.rootTask.id } });
    expect(wakes).toHaveLength(2);
    expect(wakes.find((wake) => wake.id === questionWake.id)).toMatchObject({ state: "consumed" });
    expect(wakes.find((wake) => wake.deliveryIds.includes(result.deliveryId))).toMatchObject({
      state: "bound",
    });
  });

  it("creates the automatic result after a clarification", async () => {
    const f = await fixture("owner");
    const question = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Which format?",
      intent: "question",
      deliveryKey: `question-auto-${f.parent.id}`,
    });
    if (!question.ok) throw new Error(question.error);
    const attempt = await prisma.attempt.create({
      data: { runId: f.workerRun.id, fence: 1, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.workerThread.id,
        botId: f.worker.id,
        runId: f.workerRun.id,
        taskId: f.workerRun.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "The completed answer" }],
      }),
    ).not.toBe(false);
    const parent = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: f.parent.id },
    });
    const automatic = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: parent.replyDeliveryId! },
    });
    expect(automatic).toMatchObject({ intent: "result", inReplyToDeliveryId: f.parent.id });
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: automatic.id } },
    });
    expect(wake.deliveryIds).toEqual([question.deliveryId, automatic.id]);
  });

  it("holds automatic completion behind an owner turn", async () => {
    const f = await fixture("owner");
    const attempt = await prisma.attempt.create({
      data: { runId: f.workerRun.id, fence: 1, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.workerThread.id,
        botId: f.worker.id,
        runId: f.workerRun.id,
        taskId: f.workerRun.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Completed the task" }],
      }),
    ).not.toBe(false);
    const result = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `auto-result:${f.parent.delegationId}` },
    });
    expect(result.inReplyToDeliveryId).toBe(f.parent.id);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: result.id } },
    });
    expect(wake.state).toBe("pending");
    expect(await prisma.steeringMessage.count({ where: { runId: f.activeRun!.id } })).toBe(0);
    expect(
      (await prisma.delegation.findUniqueOrThrow({ where: { id: f.parent.delegationId! } }))
        .coordinatorWokenAt,
    ).not.toBeNull();
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    expect(await dispatchBotMessageWake(prisma, wake.id)).toBeTruthy();
  });

  it("expires a pending result before it can execute and projects Expired", async () => {
    const f = await fixture("owner");
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Too late",
      intent: "result",
      deliveryKey: `expires-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: reply.deliveryId } },
    });
    await prisma.botMessageDelivery.update({
      where: { id: reply.deliveryId },
      data: { expiresAt: new Date(0) },
    });
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    expect(await dispatchBotMessageWake(prisma, wake.id)).toBeNull();
    expect(await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } })).toMatchObject(
      { state: "cancelled" },
    );
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ state: "expired", outcome: "expired" });
    const outbound = await prisma.message.findUniqueOrThrow({
      where: {
        id: (await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }))
          .outboundMessageId,
      },
    });
    expect(outbound.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deliveryId: reply.deliveryId, deliveryState: "expired" }),
      ]),
    );
  });

  it("shrinks a pending batch to its unexpired result", async () => {
    const f = await fixture("owner");
    const question = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "An expiring clarification",
      intent: "question",
      deliveryKey: `partial-question-${f.parent.id}`,
    });
    if (!question.ok) throw new Error(question.error);
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The durable answer",
      intent: "result",
      deliveryKey: `partial-result-${f.parent.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: question.deliveryId } },
    });
    await prisma.botMessageDelivery.update({
      where: { id: question.deliveryId },
      data: { expiresAt: new Date(0) },
    });
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    const runId = await dispatchBotMessageWake(prisma, wake.id);
    expect(runId).toBeTruthy();
    expect(await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } })).toMatchObject(
      { deliveryIds: [result.deliveryId] },
    );
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId! } });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
    expect(task.prompt).toContain("The durable answer");
    expect(task.prompt).not.toContain("An expiring clarification");
  });

  it("cancels a leased wake when its last delivery expires", async () => {
    const f = await fixture();
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "A short lived answer",
      intent: "result",
      deliveryKey: `leased-expiry-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: reply.deliveryId } },
    });
    await prisma.run.update({
      where: { id: wake.runId! },
      data: { status: "leased", leaseOwner: "fixture-lease", leaseFence: 1 },
    });
    await prisma.botMessageDelivery.update({
      where: { id: reply.deliveryId },
      data: { expiresAt: new Date(0) },
    });
    expect(
      await refreshBoundBotMessageWakeRun(prisma, {
        runId: wake.runId!,
        leaseOwner: "fixture-lease",
        leaseFence: 1,
      }),
    ).toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: wake.runId! } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ state: "expired" });
  });

  it("excludes expired quiet rows from capacity and expires them in reconciliation", async () => {
    const f = await fixture();
    await prisma.botMessageDelivery.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        id: randomUUID(),
        spaceId,
        userId,
        goalId: f.goal.id,
        rootTaskId: f.rootTask.id,
        conversationId: `quiet-${f.parent.id}-${index}`,
        senderBotId: f.worker.id,
        recipientBotId: f.coordinator.id,
        senderThreadId: f.workerThread.id,
        recipientThreadId: f.room.id,
        sourceRunId: f.workerRun.id,
        intent: "fyi",
        outboundMessageId: f.parent.inboundMessageId!,
        inboundMessageId: f.parent.outboundMessageId,
        state: "delivered",
        hop: 1,
        authorityFingerprint: "fixture",
        requestFingerprint: `quiet-${index}`,
        idempotencyKey: `quiet-${f.parent.id}-${index}`,
        expiresAt: new Date(0),
        deliveredAt: new Date(),
      })),
    });
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Still admitted",
      intent: "result",
      deliveryKey: `after-quiet-${f.parent.id}`,
    });
    expect(result.ok).toBe(true);
    expect(await expireQuietBotMessages(prisma, new Date(), 100)).toBe(20);
    expect(
      await prisma.botMessageDelivery.count({
        where: { rootTaskId: f.rootTask.id, intent: "fyi", state: "expired" },
      }),
    ).toBe(20);
  });
});
