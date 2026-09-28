import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import { botMessageReceiptKind, buildBotMessageWakePrompt, peerPairKey } from "@ardurbot/core";
import {
  acknowledgeBotMessageInput,
  appendBotMessageWakeInTransaction,
  checkPeerTrafficLimits,
  checkPeerWakeLimits,
  claimQuietBotMessages,
  claimSteering,
  confirmDispatchStop,
  createDb,
  createThreadEvents,
  createThreadMessage,
  dispatchBotMessageWake,
  drainParkedPeerRuns,
  expireHeldBotMessages,
  expireParkedBotMessageWakes,
  expireQuietBotMessages,
  finalizeRun,
  getBotCommunicationPolicy,
  goalBotAuthorityFingerprint,
  listBotCommunicationDeliveries,
  loadBotPresence,
  lockPeerTrafficPolicy,
  noteBotMessageReadUnconfirmed,
  type PrismaClient,
  reconcileQuietBotMessageClaims,
  refreshBoundBotMessageWakeRun,
  setBotCommunicationPaused,
} from "@ardurbot/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeBotMessageReceipt, replyToBotDelivery } from "./bot-comms.js";
import { messageBot } from "./bot-messages.js";
import { loadRunBotDirectory } from "./bot-presence-directory.js";
import { checkDelegationExecution } from "./delegation-execution.js";
import { wakeGoalAfterDelegation } from "./goal-wake.js";
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

  beforeEach(async () => {
    // Cases share a synthetic space. Keep each case's ledger inside its own rolling window.
    const outsideWindow = new Date(Date.now() - 3_600_001);
    await prisma.botMessageDelivery.updateMany({
      where: { spaceId, userId, createdAt: { gt: outsideWindow } },
      data: { createdAt: outsideWindow },
    });
    await prisma.botMessageWake.updateMany({
      where: { spaceId, userId, createdAt: { gt: outsideWindow } },
      data: { createdAt: outsideWindow },
    });
    await prisma.botMessageDelivery.updateMany({
      where: { spaceId, userId, wakeAdmittedAt: { gt: outsideWindow } },
      data: { wakeAdmittedAt: outsideWindow },
    });
    await prisma.run.updateMany({
      where: {
        spaceId,
        userId,
        OR: [
          { clientNonce: { startsWith: "peer-wake:" } },
          { clientNonce: { startsWith: "goal-wake:" } },
        ],
        createdAt: { gt: outsideWindow },
      },
      data: { createdAt: outsideWindow },
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
        perWorkerTokens: 40_000,
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
              leaseExpiresAt: untilAt,
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

  async function createQuietDelivery(
    f: Awaited<ReturnType<typeof fixture>>,
    expiresAt = f.goal.untilAt,
  ) {
    const id = randomUUID();
    return prisma.botMessageDelivery.create({
      data: {
        id,
        spaceId,
        userId,
        goalId: f.goal.id,
        rootTaskId: f.rootTask.id,
        conversationId: id,
        senderBotId: f.worker.id,
        recipientBotId: f.coordinator.id,
        senderThreadId: f.workerThread.id,
        recipientThreadId: f.room.id,
        sourceRunId: f.workerRun.id,
        intent: "fyi",
        outboundMessageId: f.parent.inboundMessageId!,
        inboundMessageId: f.parent.outboundMessageId,
        state: "delivered",
        hop: 2,
        authorityFingerprint: "fixture",
        requestFingerprint: id,
        idempotencyKey: `quiet-claim-${id}`,
        expiresAt,
      },
    });
  }

  async function completeWorker(f: Awaited<ReturnType<typeof fixture>>, text: string) {
    const attempt = await prisma.attempt.create({
      data: { runId: f.workerRun.id, fence: 1, status: "running" },
    });
    return finalizeRun(prisma, {
      spaceId,
      threadId: f.workerThread.id,
      botId: f.worker.id,
      runId: f.workerRun.id,
      taskId: f.workerRun.taskId,
      attemptId: attempt.id,
      leaseOwner: "fixture-worker",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text }],
    });
  }

  async function fillWakeQuota(f: Awaited<ReturnType<typeof fixture>>, count = 12) {
    await prisma.botMessageDelivery.createMany({
      data: Array.from({ length: count }, (_, index) => {
        const id = randomUUID();
        return {
          id,
          spaceId,
          userId,
          goalId: f.goal.id,
          rootTaskId: f.rootTask.id,
          conversationId: id,
          senderBotId: f.coordinator.id,
          recipientBotId: f.worker.id,
          senderThreadId: f.room.id,
          recipientThreadId: f.workerThread.id,
          sourceRunId: f.coordinatorRun.id,
          delegationId: `quota-${id}`,
          intent: "request",
          outboundMessageId: f.parent.outboundMessageId,
          inboundMessageId: f.parent.inboundMessageId,
          state: "delivered",
          hop: 1,
          authorityFingerprint: "fixture",
          requestFingerprint: id,
          idempotencyKey: `quota-${index}-${id}`,
          expiresAt: f.goal.untilAt,
          deliveredAt: new Date(),
          wakeAdmittedAt: new Date(),
        };
      }),
    });
  }

  it("scopes a two-room directory and rechecks a send after membership changes", async () => {
    const f = await fixture("compatible");
    await prisma.run.update({
      where: { id: f.workerRun.id },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    const second = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Second room" },
    });
    const secondThread = await prisma.thread.create({
      data: { spaceId, userId, groupId: second.id },
    });
    await prisma.chatGroupMember.create({ data: { groupId: second.id, botId: f.worker.id } });
    const secondTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: f.worker.id,
        threadId: secondThread.id,
        prompt: "Second room work",
        status: "running",
      },
    });
    await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: f.worker.id,
        threadId: secondThread.id,
        taskId: secondTask.id,
        status: "running",
        trigger: "follow_up",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const visible = await loadBotPresence(
      prisma,
      { spaceId, userId },
      { groupId: f.room.groupId!, limit: 1 },
    );
    expect(visible.bots).toHaveLength(1);
    expect(visible.nextCursor).toBeTruthy();
    const next = await loadBotPresence(
      prisma,
      { spaceId, userId },
      { groupId: f.room.groupId!, cursor: visible.nextCursor, limit: 1 },
    );
    const worker = [...visible.bots, ...next.bots].find((bot) => bot.botId === f.worker.id);
    expect(worker).toMatchObject({ availability: "busy", activeRunCount: 2 });
    expect(worker?.groupIds).toEqual(expect.arrayContaining([f.room.groupId, second.id]));
    const peerView = await loadBotPresence(
      prisma,
      { spaceId, userId },
      { callerBotId: f.coordinator.id, groupId: f.room.groupId! },
    );
    expect(peerView.bots.find((bot) => bot.botId === f.worker.id)?.groupIds).toEqual([
      f.room.groupId,
    ]);
    expect(
      (
        await loadBotPresence(
          prisma,
          { spaceId, userId },
          {
            callerBotId: f.coordinator.id,
            groupId: second.id,
          },
        )
      ).bots,
    ).toEqual([]);
    const secondView = await loadBotPresence(
      prisma,
      { spaceId, userId },
      {
        callerBotId: f.worker.id,
        visibleGroupId: second.id,
        canSend: true,
      },
    );
    expect(secondView.bots.find((bot) => bot.botId === f.coordinator.id)?.canMessage).toBe(false);
    expect((await loadBotPresence(prisma, { spaceId, userId: "other-owner" })).bots).toEqual([]);
    const before = await prisma.botMessageDelivery.count({ where: { spaceId, userId } });
    await prisma.chatGroupMember.delete({
      where: { groupId_botId: { groupId: f.room.groupId!, botId: f.worker.id } },
    });
    const refused = await messageBot(f.deps, f.coordinatorRun, f.coordinator, {
      bot_id: f.worker.id,
      message: "Check this task",
      intent: "request",
      card: { goal: "Check this task", inputs: [], doneWhen: [], deadlineAt: null },
      deliveryKey: `directory-stale-${f.parent.id}`,
    });
    expect(refused.ok).toBe(false);
    expect(await prisma.botMessageDelivery.count({ where: { spaceId, userId } })).toBe(before);
  });

  it("keeps every room member visible beyond the 40-bot desk page", async () => {
    const f = await fixture();
    await prisma.bot.createMany({
      data: Array.from({ length: 41 }, (_, index) => ({
        id: `a-outsider-${fixtureNumber}-${index}`,
        spaceId,
        userId,
        name: `Outsider ${index}`,
        color: "ink",
      })),
    });
    const member = await prisma.bot.create({
      data: {
        id: `z-member-${fixtureNumber}`,
        spaceId,
        userId,
        name: "Last room member",
        color: "ink",
      },
    });
    await prisma.chatGroupMember.create({ data: { groupId: f.room.groupId!, botId: member.id } });
    const directory = await loadRunBotDirectory(
      prisma,
      { spaceId, userId },
      f.coordinator.id,
      f.room.groupId!,
      true,
    );
    expect(directory).toContain(`Last room member (id: ${member.id})`);
    expect(directory).toContain(`(id: ${f.worker.id})`);
  });

  it("redacts an unrelated desk task in read-only peer list_bots mode", async () => {
    const f = await fixture();
    const unrelated = await prisma.bot.create({
      data: { spaceId, userId, name: "Unrelated bot", color: "ink" },
    });
    const desk = await prisma.thread.create({
      data: { spaceId, userId, botId: unrelated.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: unrelated.id,
        threadId: desk.id,
        prompt: "Private desk task",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: unrelated.id,
        threadId: desk.id,
        taskId: task.id,
        status: "running",
        trigger: "follow_up",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const result = await loadBotPresence(
      prisma,
      { spaceId, userId },
      {
        callerBotId: f.worker.id,
        visibleGroupId: "__desk__",
        canSend: true,
        limit: 50,
      },
    );
    const row = result.bots.find((bot) => bot.botId === unrelated.id);
    expect(row).toMatchObject({ availability: "busy", activeRunCount: 1, activeRunIds: [] });
    expect(row?.currentTaskTitle).toBeUndefined();
    expect(row?.goalId).toBeUndefined();
    expect(row?.delegationId).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(run.id);
    expect(JSON.stringify(row)).not.toContain(task.prompt);
  });

  it("redacts a newer private task of the same bot from a restricted worker", async () => {
    const f = await fixture();
    await prisma.run.update({
      where: { id: f.workerRun.id },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    const conversation = await prisma.externalConversation.create({
      data: {
        spaceId,
        userId,
        botId: f.worker.id,
        provider: "fixture",
        workspaceId: scopeId,
        externalKey: `private-${fixtureNumber}`,
        conversationId: `private-${fixtureNumber}`,
      },
    });
    const privateThread = await prisma.thread.create({
      data: { spaceId, userId, externalConversationId: conversation.id },
    });
    const privateTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: f.worker.id,
        threadId: privateThread.id,
        prompt: "Private message task",
        status: "running",
      },
    });
    const privateRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: f.worker.id,
        threadId: privateThread.id,
        taskId: privateTask.id,
        status: "running",
        trigger: "follow_up",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const result = await loadBotPresence(
      prisma,
      { spaceId, userId },
      {
        callerBotId: f.worker.id,
        callerThreadId: f.workerThread.id,
        visibleGroupId: "__desk__",
      },
    );
    const row = result.bots.find((bot) => bot.botId === f.worker.id);
    expect(row).toMatchObject({
      availability: "busy",
      activeRunCount: 2,
      activeRunIds: [f.workerRun.id],
    });
    expect(row?.currentTaskTitle).toBeUndefined();
    expect(row?.goalId).toBeUndefined();
    expect(row?.delegationId).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(privateRun.id);
    expect(JSON.stringify(row)).not.toContain(privateTask.prompt);
  });

  it("projects a coordinator's latest peer conversation to its group thread", async () => {
    const f = await fixture();
    const result = await loadBotPresence(prisma, { spaceId, userId });
    expect(result.bots.find((bot) => bot.botId === f.coordinator.id)?.latestDeliveryGroupId).toBe(
      f.room.groupId,
    );
    expect(
      result.bots.find((bot) => bot.botId === f.worker.id)?.latestDeliveryGroupId,
    ).toBeUndefined();
  });

  it("commits a long worker result and wakes once from its bounded receipt", async () => {
    const f = await fixture();
    expect(await completeWorker(f, "x".repeat(16_000))).not.toBe(false);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: f.workerRun.id } });
    const delegation = await prisma.delegation.findUniqueOrThrow({
      where: { id: f.parent.delegationId! },
    });
    expect(run.status).toBe("completed");
    expect(delegation.result).toHaveLength(2_000);
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `auto-result:${delegation.id}` },
    });
    expect(delivery.pairKey).toBe(peerPairKey(f.worker.id, f.coordinator.id));
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: delivery.id } },
    });
    expect(wake.promptCharacters).toBeLessThan(16_000);
    await wakeGoalAfterDelegation(f.deps, delegation.id);
    await wakeGoalAfterDelegation(f.deps, delegation.id);
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
      }),
    ).toBe(1);
  });

  it("defers a full inbox without rolling back the worker result", async () => {
    const f = await fixture();
    const extraIds = Array.from({ length: 20 }, () => randomUUID());
    await prisma.botMessageDelivery.createMany({
      data: extraIds.map((id) => ({
        id,
        spaceId,
        userId,
        goalId: f.goal.id,
        rootTaskId: f.rootTask.id,
        conversationId: id,
        senderBotId: f.worker.id,
        recipientBotId: f.coordinator.id,
        senderThreadId: f.workerThread.id,
        recipientThreadId: f.room.id,
        sourceRunId: f.workerRun.id,
        intent: "fyi",
        outboundMessageId: f.parent.inboundMessageId!,
        inboundMessageId: f.parent.outboundMessageId,
        state: "delivered",
        hop: 2,
        authorityFingerprint: "fixture",
        requestFingerprint: id,
        idempotencyKey: `full-${id}`,
        expiresAt: f.goal.untilAt,
      })),
    });
    expect(await completeWorker(f, "Finished the work")).not.toBe(false);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: f.workerRun.id } })).status).toBe(
      "completed",
    );
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `auto-result:${f.parent.delegationId}` },
    });
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: delivery.id } },
    });
    expect(delivery.failureCode).toBe("inbox-full");
    expect(wake.state).toBe("pending");
    expect(wake.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    await prisma.botMessageDelivery.updateMany({
      where: { id: { in: extraIds } },
      data: { outcome: "consumed" },
    });
    await prisma.botMessageWake.update({
      where: { id: wake.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const runId = (await dispatchBotMessageWake(prisma, wake.id)).runId;
    expect(runId).toBeTruthy();
    expect(
      (await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .failureCode,
    ).toBeNull();
  });

  it.each(["archived", "replaced"] as const)(
    "settles an automatic wake when the group coordinator is %s",
    async (change) => {
      const f = await fixture();
      if (change === "archived")
        await prisma.chatGroup.update({
          where: { id: f.goal.groupId },
          data: { archivedAt: new Date() },
        });
      else {
        const replacement = await prisma.bot.create({
          data: { spaceId, userId, name: "Replacement", color: "ink" },
        });
        await prisma.chatGroup.update({
          where: { id: f.goal.groupId },
          data: { coordinatorBotId: replacement.id },
        });
      }
      expect(await completeWorker(f, "Finished the work")).not.toBe(false);
      const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
        where: { idempotencyKey: `auto-result:${f.parent.delegationId}` },
      });
      const wake = await prisma.botMessageWake.findFirstOrThrow({
        where: { deliveryIds: { has: delivery.id } },
      });
      expect((await dispatchBotMessageWake(prisma, wake.id)).runId).toBeNull();
      expect(
        await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } }),
      ).toMatchObject({ state: "cancelled" });
      expect(
        await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).toMatchObject({ state: "failed", failureCode: "group-unavailable" });
      expect(
        await prisma.run.count({
          where: { goalId: f.goal.id, clientNonce: { startsWith: "peer-wake:" } },
        }),
      ).toBe(0);
    },
  );

  it("cancels a bound coordinator run if the group is archived before execution", async () => {
    const f = await fixture();
    expect(await completeWorker(f, "Finished the work")).not.toBe(false);
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `auto-result:${f.parent.delegationId}` },
    });
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: delivery.id } },
    });
    const runId = (await dispatchBotMessageWake(prisma, wake.id)).runId;
    expect(runId).toBeTruthy();
    await prisma.run.update({
      where: { id: runId! },
      data: { status: "leased", leaseOwner: "fixture-claim", leaseFence: 1 },
    });
    await prisma.chatGroup.update({
      where: { id: f.goal.groupId },
      data: { archivedAt: new Date() },
    });
    expect(
      await refreshBoundBotMessageWakeRun(prisma, {
        runId: runId!,
        leaseOwner: "fixture-claim",
        leaseFence: 1,
      }),
    ).toBe(false);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId! } })).status).toBe(
      "cancelled",
    );
    expect(
      (await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .failureCode,
    ).toBe("group-unavailable");
  });

  it("backfills one wake for a pre-upgrade automatic delivery without a wake", async () => {
    const f = await fixture();
    expect(await completeWorker(f, "Finished the work")).not.toBe(false);
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `auto-result:${f.parent.delegationId}` },
    });
    await prisma.botMessageWake.deleteMany({ where: { deliveryIds: { has: delivery.id } } });
    await prisma.delegation.update({
      where: { id: f.parent.delegationId! },
      data: { coordinatorWokenAt: null },
    });
    await wakeGoalAfterDelegation(f.deps, f.parent.delegationId);
    await wakeGoalAfterDelegation(f.deps, f.parent.delegationId);
    expect(
      await prisma.botMessageWake.count({ where: { deliveryIds: { has: delivery.id } } }),
    ).toBe(1);
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

  it("replays a quiet delivery after an interrupted fenced claim", async () => {
    const f = await fixture("compatible");
    const { id } = await createQuietDelivery(f);
    await claimQuietBotMessages(prisma, {
      runId: f.coordinatorRun.id,
      leaseOwner: "fixture-active",
      leaseFence: 1,
      deliveryIds: [id],
    });
    expect(await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      outcome: null,
      quietClaimRunId: f.coordinatorRun.id,
      quietClaimLeaseFence: 1,
    });
    await prisma.run.update({
      where: { id: f.coordinatorRun.id },
      data: { status: "queued", leaseOwner: null, leaseFence: 2 },
    });
    await reconcileQuietBotMessageClaims(prisma);
    expect(
      (await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).quietClaimRunId,
    ).toBeNull();
    await prisma.run.update({
      where: { id: f.coordinatorRun.id },
      data: { status: "running", leaseOwner: "fixture-retry" },
    });
    await claimQuietBotMessages(prisma, {
      runId: f.coordinatorRun.id,
      leaseOwner: "fixture-retry",
      leaseFence: 2,
      deliveryIds: [id],
    });
    const attempt = await prisma.attempt.create({
      data: { runId: f.coordinatorRun.id, fence: 2, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.room.id,
        botId: f.coordinator.id,
        runId: f.coordinatorRun.id,
        taskId: f.coordinatorRun.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-retry",
        leaseFence: 2,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).not.toBe(false);
    expect(await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      outcome: "consumed",
      quietClaimRunId: null,
    });
  });

  it("reads quiet content only after the current lease claims its batch", async () => {
    const f = await fixture("compatible");
    const id = randomUUID();
    await prisma.botMessageDelivery.create({
      data: {
        id,
        spaceId,
        userId,
        goalId: f.goal.id,
        rootTaskId: f.rootTask.id,
        conversationId: id,
        senderBotId: f.worker.id,
        recipientBotId: f.coordinator.id,
        senderThreadId: f.workerThread.id,
        recipientThreadId: f.room.id,
        sourceRunId: f.workerRun.id,
        intent: "fyi",
        outboundMessageId: f.parent.inboundMessageId!,
        inboundMessageId: f.parent.outboundMessageId,
        state: "delivered",
        hop: 2,
        authorityFingerprint: "fixture",
        requestFingerprint: id,
        idempotencyKey: `quiet-read-${id}`,
        expiresAt: f.goal.untilAt,
      },
    });
    const ack = {
      runId: f.coordinatorRun.id,
      leaseFence: 1,
      deliveryIds: [id],
      mode: "initial" as const,
    };
    expect(await acknowledgeBotMessageInput(prisma, ack, [id])).toMatchObject({
      changed: 0,
      refused: "foreign-delivery",
    });
    await claimQuietBotMessages(prisma, {
      runId: f.coordinatorRun.id,
      leaseOwner: "fixture-active",
      leaseFence: 1,
      deliveryIds: [id],
    });
    expect(await acknowledgeBotMessageInput(prisma, ack, [id])).toMatchObject({
      changed: 1,
      refused: null,
    });
    expect(await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "read",
      outcome: "consumed",
      quietClaimRunId: null,
      quietClaimLeaseFence: null,
    });
  });

  it("completes a turn with only quiet deliveries still available at claim time", async () => {
    const f = await fixture("compatible");
    const expired = await createQuietDelivery(f);
    const available = await createQuietDelivery(f);
    // The executor selected both rows before the first one expired.
    await prisma.botMessageDelivery.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const claimedIds = await claimQuietBotMessages(prisma, {
      runId: f.coordinatorRun.id,
      leaseOwner: "fixture-active",
      leaseFence: 1,
      deliveryIds: [expired.id, available.id],
    });
    expect(claimedIds).toEqual([available.id]);
    expect(await expireQuietBotMessages(prisma)).toBeGreaterThan(0);
    const attempt = await prisma.attempt.create({
      data: { runId: f.coordinatorRun.id, fence: 1, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.room.id,
        botId: f.coordinator.id,
        runId: f.coordinatorRun.id,
        taskId: f.coordinatorRun.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-active",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Turn completed" }],
      }),
    ).not.toBe(false);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: expired.id } }),
    ).toMatchObject({
      state: "expired",
      outcome: "expired",
      quietClaimRunId: null,
    });
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: available.id } }),
    ).toMatchObject({
      outcome: "consumed",
      quietClaimRunId: null,
    });
  });

  it("keeps a claimed quiet delivery stable while context assembly crosses expiry", async () => {
    const f = await fixture("compatible");
    const { id } = await createQuietDelivery(f);
    expect(
      await claimQuietBotMessages(prisma, {
        runId: f.coordinatorRun.id,
        leaseOwner: "fixture-active",
        leaseFence: 1,
        deliveryIds: [id],
      }),
    ).toEqual([id]);
    await prisma.botMessageDelivery.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expireQuietBotMessages(prisma);
    expect(await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "delivered",
      outcome: null,
      quietClaimRunId: f.coordinatorRun.id,
    });
    const attempt = await prisma.attempt.create({
      data: { runId: f.coordinatorRun.id, fence: 1, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.room.id,
        botId: f.coordinator.id,
        runId: f.coordinatorRun.id,
        taskId: f.coordinatorRun.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-active",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Turn completed" }],
      }),
    ).not.toBe(false);
    expect(await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      outcome: "consumed",
      quietClaimRunId: null,
    });
  });

  it("rejects an old attempt after its replacement claims the quiet delivery", async () => {
    const f = await fixture("compatible");
    const { id } = await createQuietDelivery(f);
    const oldAttempt = await prisma.run.findUniqueOrThrow({ where: { id: f.coordinatorRun.id } });
    expect(oldAttempt.leaseFence).toBe(1);
    let replacementLocked!: () => void;
    let commitReplacement!: () => void;
    let resumeLookup!: () => void;
    let lookupReached = false;
    let staleBackendPid: number | undefined;
    const replacementAtLock = new Promise<void>((resolve) => {
      replacementLocked = resolve;
    });
    const replacementGate = new Promise<void>((resolve) => {
      commitReplacement = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      resumeLookup = resolve;
    });
    const replacement = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${f.coordinatorRun.id} FOR UPDATE`;
      await tx.run.update({
        where: { id: f.coordinatorRun.id },
        data: { leaseOwner: "fixture-replacement", leaseFence: 2 },
      });
      await tx.botMessageDelivery.update({
        where: { id },
        data: { quietClaimRunId: f.coordinatorRun.id, quietClaimLeaseFence: 2 },
      });
      replacementLocked();
      await replacementGate;
    });
    void replacement.catch(() => undefined);
    await replacementAtLock;
    const gatedPrisma = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (work: (tx: typeof prisma) => Promise<unknown>) =>
          prisma.$transaction(async (tx) => {
            const backend = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            staleBackendPid = backend[0]?.pid;
            return work(
              new Proxy(tx, {
                get(inner, key, innerReceiver) {
                  if (key !== "run") return Reflect.get(inner, key, innerReceiver);
                  return new Proxy(tx.run, {
                    get(run, operation, runReceiver) {
                      if (operation !== "findFirst")
                        return Reflect.get(run, operation, runReceiver);
                      return async (...args: unknown[]) => {
                        const found = await (
                          tx.run.findFirst as (...args: unknown[]) => Promise<unknown>
                        )(...args);
                        lookupReached = true;
                        await lookupGate;
                        return found;
                      };
                    },
                  });
                },
              }) as typeof prisma,
            );
          });
      },
    }) as PrismaClient;
    const staleClaim = claimQuietBotMessages(gatedPrisma, {
      runId: f.coordinatorRun.id,
      leaseOwner: oldAttempt.leaseOwner!,
      leaseFence: oldAttempt.leaseFence,
      deliveryIds: [id],
    });
    void staleClaim.catch(() => undefined);
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (staleBackendPid) {
          const [row] = await prisma.$queryRaw<{ blockers: number[] }[]>`
            SELECT pg_blocking_pids(${staleBackendPid}) AS blockers`;
          blocked = (row?.blockers.length ?? 0) > 0;
        }
        if (blocked || lookupReached) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked || lookupReached).toBe(true);
    } finally {
      commitReplacement();
      resumeLookup();
    }
    await replacement;
    await expect(staleClaim).rejects.toThrow("lost its run lease");
    expect(await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      quietClaimRunId: f.coordinatorRun.id,
      quietClaimLeaseFence: 2,
    });
    expect(
      await claimQuietBotMessages(prisma, {
        runId: f.coordinatorRun.id,
        leaseOwner: "fixture-replacement",
        leaseFence: 2,
        deliveryIds: [id],
      }),
    ).toEqual([id]);
    const attempt = await prisma.attempt.create({
      data: { runId: f.coordinatorRun.id, fence: 2, status: "running" },
    });
    expect(
      await finalizeRun(prisma, {
        spaceId,
        threadId: f.room.id,
        botId: f.coordinator.id,
        runId: f.coordinatorRun.id,
        taskId: f.coordinatorRun.taskId,
        attemptId: attempt.id,
        leaseOwner: "fixture-replacement",
        leaseFence: 2,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Replacement completed" }],
      }),
    ).not.toBe(false);
    expect(await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
      outcome: "consumed",
      quietClaimRunId: null,
    });
    expect(await reconcileQuietBotMessageClaims(prisma)).toBe(0);
  });

  it("recovers a newer abandoned claim beyond a full page of healthy claims", async () => {
    const f = await fixture("compatible");
    const healthyIds = (
      await Promise.all(Array.from({ length: 101 }, () => createQuietDelivery(f)))
    ).map((delivery) => delivery.id);
    await prisma.botMessageDelivery.updateMany({
      where: { id: { in: healthyIds } },
      data: { quietClaimRunId: f.coordinatorRun.id, quietClaimLeaseFence: 1 },
    });
    const abandoned = await createQuietDelivery(f);
    await prisma.botMessageDelivery.update({
      where: { id: abandoned.id },
      data: {
        createdAt: new Date(Date.now() + 1_000),
        quietClaimRunId: f.workerRun.id,
        quietClaimLeaseFence: 1,
      },
    });
    expect(await reconcileQuietBotMessageClaims(prisma, 100)).toBe(1);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: abandoned.id } }),
    ).toMatchObject({
      quietClaimRunId: null,
      quietClaimLeaseFence: null,
    });
    expect(
      await prisma.botMessageDelivery.count({
        where: { id: { in: healthyIds }, quietClaimRunId: f.coordinatorRun.id },
      }),
    ).toBe(101);
  });

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
    for (const id of [parent.outboundMessageId, parent.inboundMessageId]) {
      const message = await prisma.message.findUniqueOrThrow({ where: { id: id! } });
      expect(message.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ deliveryId: parent.id, deliveryState: "replied" }),
        ]),
      );
    }
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

  it("reads an idle desk request on its first accepted turn", async () => {
    const f = await fixture();
    const notify = vi.spyOn(f.deps.events, "notify").mockResolvedValue();
    const result = await acknowledgeBotMessageReceipt(
      f.deps,
      {
        runId: f.workerRun.id,
        leaseFence: 1,
        deliveryIds: [f.parent.id],
        mode: "initial",
      },
      [f.parent.id],
    );
    expect(result).toMatchObject({ changed: 1, refused: null });
    expect(result.updatedThreads.map(({ threadId }) => threadId)).toEqual([
      f.room.id,
      f.workerThread.id,
    ]);
    expect(notify.mock.calls).toEqual(
      result.updatedThreads.map(({ threadId, seq }) => [threadId, seq]),
    );
    const parent = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: f.parent.id },
    });
    expect(parent).toMatchObject({ state: "read", failureCode: null });
    for (const id of [parent.outboundMessageId, parent.inboundMessageId]) {
      const message = await prisma.message.findUniqueOrThrow({ where: { id: id! } });
      expect(message.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ deliveryId: parent.id, deliveryState: "read" }),
        ]),
      );
      if (id === parent.outboundMessageId) {
        const block = (message.blocks as Array<{ kind: string }>).find(
          (item) => item.kind === "bot_message_sent",
        );
        expect(botMessageReceiptKind(block as Parameters<typeof botMessageReceiptKind>[0])).toBe(
          "read",
        );
      }
    }
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

  it("marks an idle delivery Read only for its owning run and fresh lease", async () => {
    const f = await fixture();
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `read-${f.parent.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    const run = await prisma.run.update({
      where: { id: wake.runId! },
      data: { status: "running", leaseOwner: "fixture-read", leaseFence: 4 },
    });
    const receipt = {
      runId: run.id,
      leaseFence: 4,
      deliveryIds: [result.deliveryId],
      mode: "initial" as const,
    };
    expect(
      await acknowledgeBotMessageInput(prisma, { ...receipt, leaseFence: 3 }, receipt.deliveryIds),
    ).toMatchObject({
      changed: 0,
      refused: "stale-fence",
    });
    expect(await acknowledgeBotMessageInput(prisma, receipt, [])).toMatchObject({
      changed: 0,
      refused: "foreign-delivery",
    });
    const foreign = await fixture();
    expect(
      await acknowledgeBotMessageInput(
        prisma,
        {
          ...receipt,
          deliveryIds: [foreign.parent.id],
        },
        [foreign.parent.id],
      ),
    ).toMatchObject({ changed: 0, refused: "foreign-delivery" });
    expect(await acknowledgeBotMessageInput(prisma, receipt, receipt.deliveryIds)).toMatchObject({
      changed: 1,
      refused: null,
    });
    expect(await acknowledgeBotMessageInput(prisma, receipt, receipt.deliveryIds)).toMatchObject({
      changed: 0,
      refused: null,
    });
    const delivery = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
    });
    expect(delivery).toMatchObject({ state: "read", failureCode: null });
    expect(delivery.readAt).not.toBeNull();
    for (const id of [delivery.outboundMessageId, delivery.inboundMessageId]) {
      const message = await prisma.message.findUniqueOrThrow({ where: { id: id! } });
      expect(message.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ deliveryId: delivery.id, deliveryState: "read" }),
        ]),
      );
    }
    await expect(
      acknowledgeBotMessageInput(
        prisma,
        { ...receipt, mode: "unsupported" as never },
        receipt.deliveryIds,
      ),
    ).rejects.toThrow("Unsupported bot message input acknowledgement mode");
  });

  it("marks busy steering Read at the next turn and keeps native input Delivered", async () => {
    const f = await fixture("compatible");
    const result = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `busy-read-${f.parent.id}`,
    });
    if (!result.ok) throw new Error(result.error);
    const ack = { runId: f.activeRun!.id, leaseFence: 1, deliveryIds: [result.deliveryId] };
    expect(
      await acknowledgeBotMessageInput(prisma, { ...ack, mode: "steering" }, ack.deliveryIds),
    ).toMatchObject({
      changed: 0,
      refused: "foreign-delivery",
    });
    await claimSteering(prisma, {
      threadId: f.room.id,
      botId: f.coordinator.id,
      runId: f.activeRun!.id,
      leaseOwner: "fixture-active",
      leaseFence: 1,
      seenIds: [],
    });
    expect(
      await acknowledgeBotMessageInput(prisma, { ...ack, mode: "steering" }, ack.deliveryIds),
    ).toMatchObject({
      changed: 1,
      refused: null,
    });
    const native = await fixture();
    expect(
      await noteBotMessageReadUnconfirmed(prisma, {
        runId: native.workerRun.id,
        leaseFence: 1,
        deliveryIds: [native.parent.id],
      }),
    ).toBe(1);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: native.parent.id } }),
    ).toMatchObject({
      state: "delivered",
      failureCode: "read-unconfirmed",
      readAt: null,
    });
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
    expect((await dispatchBotMessageWake(prisma, wake.id)).runId).toBeNull();
    await prisma.botMessageWake.update({
      where: { id: wake.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const rebound = (await dispatchBotMessageWake(prisma, wake.id)).runId;
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
    const rebound = (await dispatchBotMessageWake(prisma, wake.id)).runId;
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
    await prisma.run.update({
      where: { id: rebound! },
      data: { status: "running", leaseOwner: "fixture-replay", leaseFence: 2 },
    });
    expect(
      await acknowledgeBotMessageInput(
        prisma,
        {
          runId: rebound!,
          leaseFence: 2,
          deliveryIds: [reply.deliveryId],
          mode: "initial",
        },
        [reply.deliveryId],
      ),
    ).toMatchObject({ changed: 1, refused: null });
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ state: "read", failureCode: null });
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
    const nextRunId = (await dispatchBotMessageWake(prisma, wake.id)).runId;
    expect(nextRunId).toBeTruthy();
  });

  it("removes Waiting from both threads after a native coordinator consumes a queued reply", async () => {
    const f = await fixture("owner");
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The fixture is complete.",
      intent: "result",
      deliveryKey: `native-reply-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const delivery = await prisma.botMessageDelivery.findUniqueOrThrow({
      where: { id: reply.deliveryId },
    });
    for (const id of [delivery.outboundMessageId, delivery.inboundMessageId]) {
      const message = await prisma.message.findUniqueOrThrow({ where: { id: id! } });
      expect(message.blocks).toEqual(
        expect.arrayContaining([expect.objectContaining({ queuedForBusy: true })]),
      );
    }
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    const runId = (await dispatchBotMessageWake(prisma, wake.id)).runId;
    if (!runId) throw new Error("Queued reply was not dispatched.");
    const run = await prisma.run.update({
      where: { id: runId },
      data: { status: "running", leaseOwner: "fixture-native", leaseFence: 1 },
    });
    expect(
      await noteBotMessageReadUnconfirmed(prisma, {
        runId,
        leaseFence: 1,
        deliveryIds: [reply.deliveryId],
      }),
    ).toBe(1);
    const attempt = await prisma.attempt.create({
      data: { runId, fence: 1, status: "running" },
    });
    const publish = vi.fn(async (_topic: string, _payload: string) => undefined);
    expect(
      await finalizeRun(
        prisma,
        {
          spaceId,
          threadId: f.room.id,
          botId: f.coordinator.id,
          runId,
          taskId: run.taskId,
          attemptId: attempt.id,
          leaseOwner: "fixture-native",
          leaseFence: 1,
          outcome: "completed",
          blocks: [],
        },
        { publish } as never,
      ),
    ).not.toBe(false);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ state: "delivered", outcome: "consumed", failureCode: "read-unconfirmed" });
    for (const id of [delivery.outboundMessageId, delivery.inboundMessageId]) {
      const message = await prisma.message.findUniqueOrThrow({ where: { id: id! } });
      const block = (
        message.blocks as Array<{ deliveryId?: string; queuedForBusy?: boolean }>
      ).find((item) => item.deliveryId === reply.deliveryId);
      expect(block).toMatchObject({ deliveryState: "delivered", queuedForBusy: false });
      expect(botMessageReceiptKind(block as Parameters<typeof botMessageReceiptKind>[0])).toBe(
        "delivered",
      );
    }
    for (const threadId of [f.room.id, f.workerThread.id]) {
      const event = await prisma.event.findFirstOrThrow({
        where: { threadId, type: "thread.message.updated" },
        orderBy: { seq: "desc" },
      });
      expect(publish).toHaveBeenCalledWith(
        `thread:${threadId}`,
        JSON.stringify({ cursor: event.seq }),
      );
    }
  });

  it("removes Waiting on both quiet receipt blocks after a native turn consumes them", async () => {
    const f = await fixture();
    await prisma.run.update({ where: { id: f.coordinatorRun.id }, data: { status: "running" } });
    const ids: string[] = [];
    for (const intent of ["status", "fyi", "result"] as const) {
      const deliveryKey = `quiet-native-${intent}-${f.parent.id}`;
      const sent = await messageBot(f.deps, f.coordinatorRun, f.coordinator, {
        bot_id: f.worker.id,
        intent,
        message: `${intent} update`,
        deliveryKey,
      });
      if (!sent.ok) throw new Error(sent.error);
      const delivery = await prisma.botMessageDelivery.findUniqueOrThrow({
        where: {
          spaceId_userId_idempotencyKey: {
            spaceId,
            userId,
            idempotencyKey: `bot-message:${deliveryKey}`,
          },
        },
      });
      ids.push(delivery.id);
    }
    expect(await prisma.botMessageWake.count({ where: { rootTaskId: f.rootTask.id } })).toBe(0);
    for (const id of ids) {
      const delivery = await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } });
      for (const messageId of [delivery.outboundMessageId, delivery.inboundMessageId]) {
        const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId! } });
        const block = (message.blocks as Array<{ deliveryId?: string }>).find(
          (item) => item.deliveryId === id,
        );
        expect(botMessageReceiptKind(block as Parameters<typeof botMessageReceiptKind>[0])).toBe(
          "waiting",
        );
      }
    }
    await prisma.run.update({ where: { id: f.workerRun.id }, data: { status: "completed" } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: f.worker.id,
        threadId: f.workerThread.id,
        prompt: "Review quiet updates",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: f.worker.id,
        threadId: f.workerThread.id,
        taskId: task.id,
        status: "running",
        trigger: "follow_up",
        goalId: f.goal.id,
        delegationRootTaskId: f.rootTask.id,
        leaseOwner: "fixture-quiet-native",
        leaseFence: 1,
        leaseExpiresAt: f.goal.untilAt,
      },
    });
    expect(
      await claimQuietBotMessages(prisma, {
        runId: run.id,
        leaseOwner: "fixture-quiet-native",
        leaseFence: 1,
        deliveryIds: ids,
      }),
    ).toEqual(ids);
    expect(
      await noteBotMessageReadUnconfirmed(prisma, {
        runId: run.id,
        leaseFence: 1,
        deliveryIds: ids,
      }),
    ).toBe(3);
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const publish = vi.fn(async (_topic: string, _payload: string) => undefined);
    expect(
      await finalizeRun(
        prisma,
        {
          spaceId,
          threadId: f.workerThread.id,
          botId: f.worker.id,
          runId: run.id,
          taskId: task.id,
          attemptId: attempt.id,
          leaseOwner: "fixture-quiet-native",
          leaseFence: 1,
          outcome: "completed",
          blocks: [],
        },
        { publish } as never,
      ),
    ).not.toBe(false);
    for (const id of ids) {
      const delivery = await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id } });
      expect(delivery).toMatchObject({
        state: "delivered",
        outcome: "consumed",
        failureCode: "read-unconfirmed",
      });
      for (const messageId of [delivery.outboundMessageId, delivery.inboundMessageId]) {
        const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId! } });
        const block = (message.blocks as Array<{ deliveryId?: string }>).find(
          (item) => item.deliveryId === id,
        );
        expect(botMessageReceiptKind(block as Parameters<typeof botMessageReceiptKind>[0])).toBe(
          "delivered",
        );
        const event = await prisma.event.findFirstOrThrow({
          where: {
            threadId: message.threadId,
            type: "thread.message.updated",
            payload: { path: ["messageId"], equals: messageId! },
          },
          orderBy: { seq: "desc" },
        });
        expect(publish).toHaveBeenCalledWith(
          `thread:${message.threadId}`,
          JSON.stringify({ cursor: event.seq }),
        );
      }
    }
  });

  it.each(["goal-unavailable", "expired"] as const)(
    "publishes a pending reply that becomes %s during finalization",
    async (ending) => {
      const f = await fixture("owner");
      const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
        inReplyToDeliveryId: f.parent.id,
        message: "The fixture is complete.",
        intent: "result",
        deliveryKey: `finalize-${ending}-${f.parent.id}`,
      });
      if (!reply.ok) throw new Error(reply.error);
      const wake = await prisma.botMessageWake.findFirstOrThrow({
        where: { rootTaskId: f.rootTask.id },
      });
      expect(wake).toMatchObject({ state: "pending", runId: null });
      await prisma.run.update({
        where: { id: f.activeRun!.id },
        data: { goalId: f.goal.id, delegationRootTaskId: f.rootTask.id },
      });
      if (ending === "goal-unavailable")
        await prisma.teamGoal.update({
          where: { id: f.goal.id },
          data: { untilAt: new Date(0) },
        });
      else
        await prisma.botMessageDelivery.update({
          where: { id: reply.deliveryId },
          data: { expiresAt: new Date(0) },
        });
      const attempt = await prisma.attempt.create({
        data: { runId: f.activeRun!.id, fence: 1, status: "running" },
      });
      const publish = vi.fn(async (_topic: string, _payload: string) => undefined);
      expect(
        await finalizeRun(
          prisma,
          {
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
          },
          { publish } as never,
        ),
      ).not.toBe(false);
      const delivery = await prisma.botMessageDelivery.findUniqueOrThrow({
        where: { id: reply.deliveryId },
      });
      expect(delivery.state).toBe(ending === "expired" ? "expired" : "failed");
      const senderEvent = await prisma.event.findFirstOrThrow({
        where: {
          threadId: f.workerThread.id,
          type: "thread.message.updated",
          payload: { path: ["messageId"], equals: delivery.outboundMessageId },
        },
        orderBy: { seq: "desc" },
      });
      expect(publish).toHaveBeenCalledWith(
        `thread:${f.workerThread.id}`,
        JSON.stringify({ cursor: senderEvent.seq }),
      );
    },
  );

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
    expect((await dispatchBotMessageWake(prisma, wakes[0]!.id)).runId).toBeNull();
    await prisma.run.update({ where: { id: f.activeRun!.id }, data: { status: "completed" } });
    const rebound = (await dispatchBotMessageWake(prisma, wakes[0]!.id)).runId;
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
      expect((await dispatchBotMessageWake(prisma, wake.id)).runId).toBeNull();
      await prisma.botMessageWake.update({
        where: { id: wake.id },
        data: { nextAttemptAt: new Date(0) },
      });
      runId = (await dispatchBotMessageWake(prisma, wake.id)).runId!;
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
    const questionRunId = (await dispatchBotMessageWake(prisma, questionWake.id)).runId;
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
    expect((await dispatchBotMessageWake(prisma, wake.id)).runId).toBeTruthy();
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
    const notify = vi.fn(async () => undefined);
    await createJobReconciler({
      prisma,
      jobs: f.jobs,
      events: { notify } as unknown as ReturnType<typeof createThreadEvents>,
    }).reconcileOnce();
    expect(notify).toHaveBeenCalledWith(f.workerThread.id, expect.any(Number));
    expect(notify).toHaveBeenCalledWith(f.room.id, expect.any(Number));
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
    const runId = (await dispatchBotMessageWake(prisma, wake.id)).runId;
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

  it("S4 holds a requested effect once and releases no work after denial", async () => {
    const f = await fixture();
    const rootBefore = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    await prisma.instanceIdentity.create({
      data: {
        id: "home",
        instanceId: `s4-home-${f.goal.id}`,
        publicKey: "fixture",
        fingerprint: "fixture",
        certificate: "fixture",
        certificateFingerprint: "fixture",
        privateKeyCiphertext: "fixture",
        scopes: [],
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
    await prisma.run.update({
      where: { id: f.coordinatorRun.id },
      data: { status: "running", runtimePin: pin },
    });
    const deps = {
      ...f.deps,
      resolveDelegationPin: async () =>
        ({
          kind: "resolved",
          pin,
          provider: "fixture",
          id: "fixture",
          thinkingLevel: "off",
        }) as never,
    };
    const input = {
      bot_id: f.worker.id,
      message: "Prepare the draft for review.",
      intent: "request" as const,
      card: {
        goal: "Prepare a draft",
        inputs: [{ type: "text", text: "Public fixture" }],
        doneWhen: ["Draft is ready"],
        deadlineAt: null,
      },
      requested_effects: [{ kind: "publish" as const }],
      deliveryKey: `s4-hold:${f.goal.id}`,
    };
    const sent = await messageBot(deps, f.coordinatorRun, f.coordinator, input);
    expect(sent.ok).toBe(true);
    const replay = await messageBot(deps, f.coordinatorRun, f.coordinator, input);
    expect(replay).toMatchObject({ ok: true, replayed: true });
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `bot-message:${input.deliveryKey}` },
    });
    expect(delivery.state).toBe("held");
    expect(delivery.approvalEffectId).toBeTruthy();
    expect(await prisma.externalEffect.count({ where: { id: delivery.approvalEffectId! } })).toBe(
      1,
    );
    expect(
      await prisma.deviceApprovalBinding.count({ where: { effectId: delivery.approvalEffectId! } }),
    ).toBe(1);
    const child = await prisma.run.findFirstOrThrow({
      where: { delegationId: delivery.delegationId! },
    });
    expect(child.status).toBe("waiting_input");
    expect(
      (await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: f.rootTask.id } }))
        .activeDescendants,
    ).toBe(rootBefore.activeDescendants + 1);
    expect(f.enqueued).not.toContain(child.id);
    const ask = await prisma.message.findFirstOrThrow({
      where: { threadId: f.room.id, runId: child.id, role: "bot" },
    });
    expect(
      await prisma.message.count({
        where: { threadId: f.room.id, clientNonce: `peer-hold:bot-message:${input.deliveryKey}` },
      }),
    ).toBe(1);
    expect((ask.blocks as Array<{ peerHold?: boolean }>).some((block) => block.peerHold)).toBe(
      true,
    );
    expect(
      await f.deps.events.answerRunInput({
        spaceId,
        threadId: f.room.id,
        runId: child.id,
        messageId: ask.id,
        answeredByUserId: userId,
        answer: "deny",
      }),
    ).toBe(true);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ state: "denied", outcome: "denied" });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await prisma.delegation.findUniqueOrThrow({ where: { id: delivery.delegationId! } }),
    ).toMatchObject({ status: "cancelled" });
    expect(
      await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: f.rootTask.id } }),
    ).toMatchObject({
      activeDescendants: rootBefore.activeDescendants,
      reservedTokens: rootBefore.reservedTokens,
    });
    const audit = await prisma.event.findMany({
      where: { threadId: f.room.id, type: { startsWith: "bot.message." } },
      select: { type: true, payload: true },
    });
    expect(audit.map((event) => event.type)).toEqual(
      expect.arrayContaining(["bot.message.queued", "bot.message.held", "bot.message.denied"]),
    );
    expect(JSON.stringify(audit.map((event) => event.payload))).not.toContain(
      "Prepare the draft for review.",
    );
    expect(
      await f.deps.events.answerRunInput({
        spaceId,
        threadId: f.room.id,
        runId: child.id,
        messageId: ask.id,
        answeredByUserId: userId,
        answer: "allow",
      }),
    ).toBe(false);
  });

  it("S4 revalidates a held approval after pause, resume and authority change", async () => {
    const f = await fixture();
    const pin = {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "fixture",
      effort: "off",
      credentialId: "fixture",
      revision: 0,
    };
    await prisma.run.update({
      where: { id: f.coordinatorRun.id },
      data: { status: "running", runtimePin: pin },
    });
    const deps = {
      ...f.deps,
      resolveDelegationPin: async () =>
        ({
          kind: "resolved",
          pin,
          provider: "fixture",
          id: "fixture",
          thinkingLevel: "off",
        }) as never,
    };
    const sent = await messageBot(deps, f.coordinatorRun, f.coordinator, {
      bot_id: f.worker.id,
      message: "Prepare a public draft",
      intent: "request",
      card: { goal: "Prepare a public draft", inputs: [], doneWhen: [], deadlineAt: null },
      requested_effects: [
        {
          kind: "publish",
          toolName: "publish_public_draft",
          resourceRef: "public-draft",
          argsDigest: "a".repeat(64),
        },
      ],
      deliveryKey: `s4-revalidate:${f.goal.id}`,
    });
    expect(sent.ok).toBe(true);
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `bot-message:s4-revalidate:${f.goal.id}` },
    });
    const child = await prisma.run.findFirstOrThrow({
      where: { delegationId: delivery.delegationId! },
    });
    const ask = await prisma.message.findFirstOrThrow({
      where: { threadId: f.room.id, runId: child.id, role: "bot" },
    });
    const answer = () =>
      f.deps.events.answerRunInput({
        spaceId,
        threadId: f.room.id,
        runId: child.id,
        messageId: ask.id,
        answeredByUserId: userId,
        answer: "allow",
      });
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    const paused = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    expect(await answer()).toBe(false);
    await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: false,
      expectedRevision: paused.revision,
    });
    await prisma.botMessageDelivery.update({
      where: { id: delivery.id },
      data: { authorityFingerprint: "revoked" },
    });
    expect(await answer()).toBe(false);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
      "waiting_input",
    );
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: delivery.approvalEffectId! } }))
        .status,
    ).toBe("intended");
    await prisma.botMessageDelivery.update({
      where: { id: delivery.id },
      data: { authorityFingerprint: delivery.authorityFingerprint },
    });
    await fillWakeQuota(f);
    expect(await answer()).toBe(false);
    expect(
      await prisma.event.count({
        where: { threadId: f.room.id, type: "bot.traffic.limited" },
      }),
    ).toBeGreaterThan(0);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
      "waiting_input",
    );
    await prisma.botMessageDelivery.updateMany({
      where: { goalId: f.goal.id, idempotencyKey: { startsWith: "quota-" } },
      data: { wakeAdmittedAt: new Date(Date.now() - 3_600_001) },
    });
    expect(await answer()).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("queued");
    expect(
      (await prisma.delegation.findUniqueOrThrow({ where: { id: delivery.delegationId! } })).card,
    ).toMatchObject({ peerMode: "read-only" });
    expect(
      (await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).state,
    ).toBe("delivered");
    await prisma.run.update({ where: { id: child.id }, data: { status: "running" } });
    await prisma.delegation.update({
      where: { id: delivery.delegationId! },
      data: { status: "running" },
    });
    expect(await checkDelegationExecution(prisma, child.id, "shell")).toContain("read-only");
  });

  it("S4 expires only its held delivery and closes the owner card", async () => {
    const f = await fixture();
    const rootBefore = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    const pin = {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "fixture",
      effort: "off",
      credentialId: "fixture",
      revision: 0,
    };
    await prisma.run.update({
      where: { id: f.coordinatorRun.id },
      data: { status: "running", runtimePin: pin },
    });
    const deps = {
      ...f.deps,
      resolveDelegationPin: async () =>
        ({
          kind: "resolved",
          pin,
          provider: "fixture",
          id: "fixture",
          thinkingLevel: "off",
        }) as never,
    };
    const sent = await messageBot(deps, f.coordinatorRun, f.coordinator, {
      bot_id: f.worker.id,
      message: "Prepare an expiring draft",
      intent: "request",
      card: { goal: "Prepare an expiring draft", inputs: [], doneWhen: [], deadlineAt: null },
      requested_effects: [{ kind: "unknown" }],
      deliveryKey: `s4-expire:${f.goal.id}`,
    });
    expect(sent.ok).toBe(true);
    const delivery = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `bot-message:s4-expire:${f.goal.id}` },
    });
    await prisma.botMessageDelivery.update({
      where: { id: delivery.id },
      data: { expiresAt: new Date(0) },
    });
    expect(await expireHeldBotMessages(prisma)).toBe(1);
    expect(
      (await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).state,
    ).toBe("expired");
    expect(
      await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: f.rootTask.id } }),
    ).toMatchObject({
      activeDescendants: rootBefore.activeDescendants,
      reservedTokens: rootBefore.reservedTokens,
    });
    const ask = await prisma.message.findFirstOrThrow({
      where: { threadId: f.room.id, clientNonce: `peer-hold:bot-message:s4-expire:${f.goal.id}` },
    });
    expect(ask.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ answer: "expired", status: "answered" })]),
    );
  });

  it("S4 pauses peer runs without cancelling unrelated owner work and refuses held approval", async () => {
    const f = await fixture("owner");
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    const policy = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    expect(policy.effectivePaused).toBe(true);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: f.workerRun.id } })).cancelRequestedAt,
    ).not.toBeNull();
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: f.activeRun!.id } })).cancelRequestedAt,
    ).toBeNull();
    const blocked = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Another question",
      intent: "question",
      deliveryKey: `s4-paused:${f.goal.id}`,
    });
    expect(blocked).toMatchObject({ ok: false });
    const resumed = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: false,
      expectedRevision: policy.revision,
    });
    expect(resumed.effectivePaused).toBe(false);
    expect(
      (
        await prisma.event.findMany({
          where: { threadId: f.room.id, type: { startsWith: "bot.traffic." } },
          select: { type: true },
        })
      ).map((event) => event.type),
    ).toEqual(expect.arrayContaining(["bot.traffic.paused", "bot.traffic.resumed"]));
  });

  it("S4 confirms a running peer cancellation without creating a coordinator wake during pause", async () => {
    const f = await fixture();
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    const paused = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    expect(paused.effectivePaused).toBe(true);
    expect(await confirmDispatchStop(prisma, f.workerRun.id)).toBe(true);
    await wakeGoalAfterDelegation(f.deps, f.parent.delegationId);
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "goal-wake:" } },
      }),
    ).toBe(0);
    expect(
      await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: f.rootTask.id } }),
    ).toMatchObject({ activeDescendants: 0 });
  });

  it("S4 fences an incoming reply wake on group pause and rejects changed bound authority", async () => {
    const f = await fixture();
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Draft is ready for review.",
      intent: "result",
      deliveryKey: `pause-reply-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: reply.deliveryId } },
    });
    expect(wake.state).toBe("bound");
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    const paused = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: wake.runId! } })).cancelRequestedAt,
    ).not.toBeNull();
    await prisma.remoteAuthorityPolicy.upsert({
      where: { layer_subjectId: { layer: "bot", subjectId: f.coordinator.id } },
      create: { layer: "bot", subjectId: f.coordinator.id, scopes: ["read"] },
      update: { scopes: ["read"] },
    });
    await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: false,
      expectedRevision: paused.revision,
    });
    // A leased executor may reach the pre-input boundary after the owner resumes.
    await prisma.run.update({
      where: { id: wake.runId! },
      data: { status: "leased", leaseOwner: "stale-peer", leaseFence: 1, cancelRequestedAt: null },
    });
    expect(
      await refreshBoundBotMessageWakeRun(prisma, {
        runId: wake.runId!,
        leaseOwner: "stale-peer",
        leaseFence: 1,
      }),
    ).toBe(false);
  });

  it("S4 confirms a leased wake cancelled between lease and input refresh", async () => {
    const f = await fixture();
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "Review the result.",
      intent: "result",
      deliveryKey: `lease-pause-${f.goal.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: reply.deliveryId } },
    });
    await prisma.run.update({
      where: { id: wake.runId! },
      data: { status: "leased", leaseOwner: "pause-race", leaseFence: 1 },
    });
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    const paused = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    expect(
      await refreshBoundBotMessageWakeRun(prisma, {
        runId: wake.runId!,
        leaseOwner: "pause-race",
        leaseFence: 1,
      }),
    ).toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: wake.runId! } })).toMatchObject({
      status: "cancelled",
      leaseOwner: null,
      cancelConfirmedAt: expect.any(Date),
    });
    expect(await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } })).toMatchObject(
      {
        state: "cancelled",
      },
    );
    await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: false,
      expectedRevision: paused.revision,
    });
    expect(
      await prisma.run.count({ where: { id: wake.runId!, status: { in: ["leased", "queued"] } } }),
    ).toBe(0);
  });

  it("S4 limits coordinator wake admission even for an already recorded result", async () => {
    const f = await fixture();
    await fillWakeQuota(f);
    const reply = await replyToBotDelivery(f.deps, f.workerRun, f.worker, {
      inReplyToDeliveryId: f.parent.id,
      message: "The answer is ready.",
      intent: "result",
      deliveryKey: `limited-result-${f.parent.id}`,
    });
    if (!reply.ok) throw new Error(reply.error);
    expect(
      await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: reply.deliveryId } }),
    ).toMatchObject({ outcome: "non-waking" });
    expect(
      await prisma.botMessageWake.count({ where: { deliveryIds: { has: reply.deliveryId } } }),
    ).toBe(0);
  });

  it("S4 does not wake a coordinator after a failed peer completion exhausts quota", async () => {
    const f = await fixture();
    await fillWakeQuota(f);
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
        outcome: "failed",
        error: "Worker failed.",
      }),
    ).not.toBe(false);
    await wakeGoalAfterDelegation(f.deps, f.parent.delegationId);
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "goal-wake:" } },
      }),
    ).toBe(0);
    expect(
      await prisma.delegation.findUniqueOrThrow({ where: { id: f.parent.delegationId! } }),
    ).toMatchObject({
      coordinatorWokenAt: expect.any(Date),
    });
  });

  it("S4 counts an admitted failed-completion wake against later turns", async () => {
    const f = await fixture();
    await fillWakeQuota(f, 11);
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
        outcome: "failed",
        error: "Worker failed.",
      }),
    ).not.toBe(false);
    await wakeGoalAfterDelegation(f.deps, f.parent.delegationId);
    expect(
      await prisma.run.count({
        where: { goalId: f.goal.id, clientNonce: { startsWith: "goal-wake:" } },
      }),
    ).toBe(1);
    expect(
      await prisma.$transaction((tx) =>
        checkPeerWakeLimits(tx, { spaceId, userId, goalId: f.goal.id, now: new Date() }),
      ),
    ).toBe("goal-wakes");
  });

  it("S4 enforces the wake limit when a pending automatic reply is bound", async () => {
    const f = await fixture();
    await fillWakeQuota(f);
    expect(await completeWorker(f, "The draft is ready.")).not.toBe(false);
    const automatic = await prisma.botMessageDelivery.findFirstOrThrow({
      where: { idempotencyKey: `auto-result:${f.parent.delegationId}` },
    });
    const wake = await prisma.botMessageWake.findFirstOrThrow({
      where: { deliveryIds: { has: automatic.id } },
    });
    expect((await dispatchBotMessageWake(prisma, wake.id)).runId).toBeNull();
    expect(await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } })).toMatchObject(
      {
        state: "pending",
        runId: null,
      },
    );
    await prisma.botMessageDelivery.updateMany({
      where: { goalId: f.goal.id, idempotencyKey: { startsWith: "quota-" } },
      data: { wakeAdmittedAt: new Date(Date.now() - 3_600_001) },
    });
    await prisma.botMessageWake.update({
      where: { id: wake.id },
      data: { nextAttemptAt: new Date(0) },
    });
    expect((await dispatchBotMessageWake(prisma, wake.id)).runId).toBeTruthy();
  });

  it("S4 parks paused wake batches outside the eligible scan and expires them separately", async () => {
    const pausedGoal = await fixture();
    const liveGoal = await fixture();
    const fingerprint = await prisma.$transaction((tx) =>
      goalBotAuthorityFingerprint(tx, {
        spaceId,
        userId,
        goalId: pausedGoal.goal.id,
        rootTaskId: pausedGoal.rootTask.id,
        botId: pausedGoal.coordinator.id,
      }),
    );
    await prisma.botMessageWake.createMany({
      data: Array.from({ length: 101 }, (_, index) => ({
        spaceId,
        userId,
        goalId: pausedGoal.goal.id,
        rootTaskId: pausedGoal.rootTask.id,
        recipientBotId: pausedGoal.coordinator.id,
        recipientThreadId: pausedGoal.room.id,
        authorityFingerprint: fingerprint,
        generation: index + 1,
        deliveryIds: [pausedGoal.parent.id],
        promptCharacters: 10,
        clientNonce: `paused-fair-${pausedGoal.goal.id}-${index}`,
        state: "sealed",
        createdAt: new Date(Date.now() - 30_000),
      })),
    });
    const live = await prisma.botMessageWake.create({
      data: {
        spaceId,
        userId,
        goalId: liveGoal.goal.id,
        rootTaskId: liveGoal.rootTask.id,
        recipientBotId: liveGoal.coordinator.id,
        recipientThreadId: liveGoal.room.id,
        authorityFingerprint: await prisma.$transaction((tx) =>
          goalBotAuthorityFingerprint(tx, {
            spaceId,
            userId,
            goalId: liveGoal.goal.id,
            rootTaskId: liveGoal.rootTask.id,
            botId: liveGoal.coordinator.id,
          }),
        ),
        generation: 1,
        deliveryIds: [liveGoal.parent.id],
        promptCharacters: 10,
        clientNonce: `live-fair-${liveGoal.goal.id}`,
      },
    });
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: pausedGoal.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    const eligible = await prisma.botMessageWake.findMany({
      where: {
        state: { in: ["pending", "sealed", "retry_wait"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true },
    });
    expect(eligible.map((item) => item.id)).toContain(live.id);
    await prisma.teamGoal.update({
      where: { id: pausedGoal.goal.id },
      data: { untilAt: new Date(0) },
    });
    expect(await expireParkedBotMessageWakes(prisma, new Date(), 1)).toBe(1);
    expect(
      await prisma.botMessageWake.count({
        where: { goalId: pausedGoal.goal.id, state: "cancelled" },
      }),
    ).toBe(1);
  });

  it("S4 resumes two parked batches sharing one open-batch key", async () => {
    const f = await fixture();
    const fingerprint = await prisma.$transaction((tx) =>
      goalBotAuthorityFingerprint(tx, {
        spaceId,
        userId,
        goalId: f.goal.id,
        rootTaskId: f.rootTask.id,
        botId: f.coordinator.id,
      }),
    );
    const batches = await Promise.all(
      [1, 2].map((generation) =>
        prisma.botMessageWake.create({
          data: {
            spaceId,
            userId,
            goalId: f.goal.id,
            rootTaskId: f.rootTask.id,
            recipientBotId: f.coordinator.id,
            recipientThreadId: f.room.id,
            authorityFingerprint: fingerprint,
            generation,
            deliveryIds: [f.parent.id],
            promptCharacters: 10,
            clientNonce: `resume-batch-${f.goal.id}-${generation}`,
            state: "sealed",
          },
        }),
      ),
    );
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    const paused = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    expect(
      await prisma.botMessageWake.count({
        where: { id: { in: batches.map((batch) => batch.id) }, state: "paused" },
      }),
    ).toBe(2);
    await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: false,
      expectedRevision: paused.revision,
    });
    expect(
      await prisma.botMessageWake.count({
        where: {
          id: { in: batches.map((batch) => batch.id) },
          state: { in: ["pending", "sealed", "retry_wait"] },
        },
      }),
    ).toBe(2);
    expect(
      await prisma.botMessageWake.count({
        where: { id: { in: batches.map((batch) => batch.id) }, state: "pending" },
      }),
    ).toBeLessThanOrEqual(1);
    const first = await dispatchBotMessageWake(prisma, batches[0]!.id);
    expect(first.runId).toBeTruthy();
    expect((await dispatchBotMessageWake(prisma, batches[1]!.id)).runId).toBeNull();
    expect(
      (await prisma.botMessageWake.findUniqueOrThrow({ where: { id: batches[1]!.id } })).state,
    ).toBe("sealed");
    await prisma.run.update({ where: { id: first.runId! }, data: { status: "completed" } });
    expect((await dispatchBotMessageWake(prisma, batches[1]!.id)).runId).toBeTruthy();
  });

  it.each(["stopped", "expired"])(
    "S4 settles a parked direct request after its goal is %s",
    async (reason) => {
      const f = await fixture();
      await prisma.run.update({ where: { id: f.workerRun.id }, data: { status: "queued" } });
      await prisma.task.update({ where: { id: f.workerRun.taskId }, data: { status: "queued" } });
      await prisma.delegation.update({
        where: { id: f.parent.delegationId! },
        data: { status: "queued" },
      });
      const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
      const paused = await setBotCommunicationPaused(prisma, actor, {
        scope: "group",
        groupId: f.goal.groupId,
        paused: true,
        expectedRevision: 1,
      });
      expect((await prisma.run.findUniqueOrThrow({ where: { id: f.workerRun.id } })).status).toBe(
        "peer_paused",
      );
      await prisma.teamGoal.update({
        where: { id: f.goal.id },
        data:
          reason === "stopped"
            ? { status: "stopped" }
            : { status: "exhausted", untilAt: new Date(0) },
      });
      if (reason === "stopped") await drainParkedPeerRuns(prisma);
      await setBotCommunicationPaused(prisma, actor, {
        scope: "group",
        groupId: f.goal.groupId,
        paused: false,
        expectedRevision: paused.revision,
      });
      await drainParkedPeerRuns(prisma);
      expect(await prisma.run.findUniqueOrThrow({ where: { id: f.workerRun.id } })).toMatchObject({
        status: "cancelled",
      });
      expect(
        await prisma.delegation.findUniqueOrThrow({ where: { id: f.parent.delegationId! } }),
      ).toMatchObject({ status: "cancelled" });
      expect(
        await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: f.rootTask.id } }),
      ).toMatchObject({ activeDescendants: 0 });
      expect(
        await prisma.botMessageDelivery.findUniqueOrThrow({ where: { id: f.parent.id } }),
      ).toMatchObject({ state: "cancelled" });
    },
  );

  it("S4 resumes only one parked direct request per recipient and settles stale authority", async () => {
    const f = await fixture();
    const pin = {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "fixture",
      effort: "off",
      credentialId: "fixture",
      revision: 0,
    };
    await prisma.run.update({
      where: { id: f.coordinatorRun.id },
      data: { status: "running", runtimePin: pin },
    });
    await prisma.delegationRoot.update({
      where: { rootTaskId: f.rootTask.id },
      data: { maxConcurrent: 4 },
    });
    await prisma.delegation.update({
      where: { id: f.parent.delegationId! },
      data: { parentRunId: f.workerRun.id },
    });
    const deps = {
      ...f.deps,
      resolveDelegationPin: async () =>
        ({
          kind: "resolved",
          pin,
          provider: "fixture",
          id: "fixture",
          thinkingLevel: "off",
        }) as never,
    };
    const send = (suffix: string) =>
      messageBot(deps, f.coordinatorRun, f.coordinator, {
        bot_id: f.worker.id,
        message: `Prepare public draft ${suffix}`,
        intent: "request",
        card: {
          goal: `Prepare public draft ${suffix}`,
          inputs: [],
          doneWhen: [],
          deadlineAt: null,
        },
        requested_effects: [],
        deliveryKey: `resume-${suffix}-${f.goal.id}`,
      });
    expect((await send("a")).ok).toBe(true);
    expect((await send("b")).ok).toBe(true);
    const direct = await prisma.botMessageDelivery.findMany({
      where: { goalId: f.goal.id, idempotencyKey: { startsWith: "bot-message:resume-" } },
      orderBy: { id: "asc" },
    });
    expect(direct).toHaveLength(2);
    const actor = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: true };
    const paused = await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: true,
      expectedRevision: 1,
    });
    expect(
      await prisma.run.count({
        where: {
          delegationId: { in: direct.map((item) => item.delegationId!) },
          status: "peer_paused",
        },
      }),
    ).toBe(2);
    expect(await confirmDispatchStop(prisma, f.workerRun.id)).toBe(true);
    await setBotCommunicationPaused(prisma, actor, {
      scope: "group",
      groupId: f.goal.groupId,
      paused: false,
      expectedRevision: paused.revision,
    });
    const first = await drainParkedPeerRuns(prisma);
    expect(first.runIds).toHaveLength(1);
    expect(
      await prisma.run.count({
        where: {
          delegationId: { in: direct.map((item) => item.delegationId!) },
          status: "peer_ready",
        },
      }),
    ).toBe(1);
    const remaining = await prisma.run.findFirstOrThrow({
      where: {
        delegationId: { in: direct.map((item) => item.delegationId!) },
        status: "peer_ready",
      },
    });
    const rootBefore = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: f.rootTask.id },
    });
    await prisma.remoteAuthorityPolicy.upsert({
      where: { layer_subjectId: { layer: "bot", subjectId: f.worker.id } },
      create: { layer: "bot", subjectId: f.worker.id, scopes: ["read"] },
      update: { scopes: ["read"] },
    });
    await drainParkedPeerRuns(prisma);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: remaining.id } })).status).toBe(
      "cancelled",
    );
    expect(
      await prisma.botMessageDelivery.findFirstOrThrow({
        where: { delegationId: remaining.delegationId! },
      }),
    ).toMatchObject({ state: "cancelled", outcome: "cancelled" });
    expect(
      (await prisma.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: f.rootTask.id } }))
        .activeDescendants,
    ).toBe(rootBefore.activeDescendants - 1);
  });

  it("S4 serializes a rolling pair limit across roots", async () => {
    const f = await fixture();
    const now = new Date();
    const pairKey = peerPairKey(f.coordinator.id, f.worker.id);
    const base = {
      spaceId,
      userId,
      goalId: f.goal.id,
      senderBotId: f.coordinator.id,
      recipientBotId: f.worker.id,
      pairKey,
      senderThreadId: f.room.id,
      recipientThreadId: f.workerThread.id,
      sourceRunId: f.coordinatorRun.id,
      intent: "request",
      outboundMessageId: f.parent.outboundMessageId,
      inboundMessageId: f.parent.inboundMessageId,
      state: "delivered",
      hop: 1,
      authorityFingerprint: "fixture",
      expiresAt: f.goal.untilAt,
    };
    for (let index = 0; index < 3; index++)
      await prisma.botMessageDelivery.create({
        data: {
          ...base,
          rootTaskId: `other-root-${index}`,
          conversationId: randomUUID(),
          requestFingerprint: `s4-pair-${index}`,
          idempotencyKey: `s4-pair-${f.goal.id}-${index}`,
          createdAt: new Date(now.getTime() - 30_000),
        },
      });
    const admitted = await Promise.all(
      [0, 1].map((index) =>
        prisma.$transaction(async (tx) => {
          await lockPeerTrafficPolicy(tx, { spaceId, userId, groupId: f.goal.groupId });
          const limit = await checkPeerTrafficLimits(tx, {
            spaceId,
            userId,
            groupId: f.goal.groupId,
            goalId: f.goal.id,
            senderBotId: f.coordinator.id,
            recipientBotId: f.worker.id,
            wakes: true,
            now: new Date(),
          });
          if (limit) return false;
          await tx.botMessageDelivery.create({
            data: {
              ...base,
              rootTaskId: `concurrent-root-${index}`,
              conversationId: randomUUID(),
              requestFingerprint: `s4-concurrent-${index}`,
              idempotencyKey: `s4-concurrent-${f.goal.id}-${index}`,
            },
          });
          return true;
        }),
      ),
    );
    expect(admitted.filter(Boolean)).toHaveLength(1);
  });

  it("S4 keeps policy and delivery reads owner-only", async () => {
    const f = await fixture();
    const member = { userId, spaceId, email: `${scopeId}@ardurbot.test`, isDeploymentOwner: false };
    await expect(getBotCommunicationPolicy(prisma, member, f.goal.groupId)).rejects.toThrow();
    await expect(
      setBotCommunicationPaused(prisma, member, {
        scope: "space",
        paused: true,
        expectedRevision: 1,
      }),
    ).rejects.toThrow();
    await expect(listBotCommunicationDeliveries(prisma, member, { limit: 10 })).rejects.toThrow();
  });
});
