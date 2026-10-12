import type { Actor } from "@ardurbot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchBotMessageWake } from "./bot-comms.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { admitDelegation } from "./delegation.js";
import { snapshot as delegationSnapshot } from "./delegation-test-fixture.js";
import {
  acceptGoal,
  admitGoalRunEffect,
  claimGoalRunEffect,
  rejectGoal,
  reviewGoalCondition,
  submitGoal,
} from "./goals.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("Goal admission freeze and settlement (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `goal-freeze-org-${suffix}`;
  const spaceId = `goal-freeze-space-${suffix}`;
  const userId = `goal-freeze-user-${suffix}`;
  const actor: Actor = { spaceId, userId, email: "owner@example.test", isDeploymentOwner: true };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let coordinatorBotId: string;
  let workerBotId: string;
  let goalCount = 0;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Goal freeze fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Goal freeze fixture" } },
      },
    });
    const coordinator = await prisma.bot.create({
      data: { spaceId, userId, name: "Goal freeze coordinator", color: "ink" },
    });
    coordinatorBotId = coordinator.id;
    const worker = await prisma.bot.create({
      data: { spaceId, userId, name: "Goal freeze worker", color: "ink" },
    });
    workerBotId = worker.id;
    // Bot message wakes carry a user foreign key.
    await prisma.user.create({
      data: { id: userId, name: "Goal freeze owner", email: "owner@example.test" },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.delete({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function createGoal() {
    goalCount += 1;
    const group = await prisma.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: `Goal freeze fixture ${goalCount}`,
        coordinatorBotId,
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId: coordinatorBotId } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: thread.id,
        prompt: "Fixture",
        status: "completed",
      },
    });
    const goal = await prisma.teamGoal.create({
      data: {
        spaceId,
        userId,
        groupId: group.id,
        threadId: thread.id,
        coordinatorBotId,
        rootTaskId: task.id,
        objective: "Review fixture",
        status: "running",
        tokenLimit: 100_000,
        perWorkerTokens: 10_000,
        maxConcurrent: 4,
        maxDescendants: 12,
        untilAt: new Date(Date.now() + 3_600_000),
      },
    });
    await prisma.delegationRoot.create({
      data: {
        rootTaskId: task.id,
        spaceId,
        userId,
        coordinatorBotId,
        coordinatorThreadId: thread.id,
        tokenLimit: 100_000,
        maxConcurrent: 4,
        maxDescendants: 12,
        activeDescendants: 0,
        deadlineAt: goal.untilAt,
      },
    });
    return goal;
  }

  const submit = (goalId: string) =>
    submitGoal(prisma, actor, { goalId, summary: "Candidate", artifacts: [], reports: [] });

  async function passConditions(goalId: string, revisionId: string) {
    await reviewGoalCondition(prisma, actor, {
      goalId,
      revisionId,
      conditionId: "cond-final",
      status: "pass",
    });
  }

  it("cancels queued coordinator and worker runs when the submission freezes the goal", async () => {
    const goal = await createGoal();
    const staleTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        prompt: "Stale queued turn",
        status: "queued",
      },
    });
    const staleRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: staleTask.id,
        status: "queued",
        trigger: "follow_up",
        clientNonce: `goal-wake:fixture-${goal.id}`,
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    // A worker assignment admitted before the freeze: queued run plus its delegation.
    const parentRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: goal.rootTaskId,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    const workerTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: workerBotId,
        threadId: goal.threadId,
        prompt: "Delegated work",
        status: "queued",
      },
    });
    const workerRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: workerBotId,
        threadId: goal.threadId,
        taskId: workerTask.id,
        status: "queued",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    const frozenDelegation = await prisma.delegation.create({
      data: {
        rootTaskId: goal.rootTaskId,
        parentRunId: parentRun.id,
        runId: workerRun.id,
        spaceId,
        userId,
        requesterBotId: coordinatorBotId,
        actingBotId: workerBotId,
        requesterName: "Coordinator",
        actingName: "Worker",
        kind: "group-handoff",
        depth: 1,
        hop: 1,
        status: "queued",
        snapshot: {},
        authority: {},
        reservedTokens: 10_000,
        attemptReservedTokens: 10_000,
        deadlineAt: goal.untilAt,
        admissionKey: `freeze-fixture-${goal.id}`,
        fingerprint: `freeze-fingerprint-${goal.id}`,
      },
    });
    await prisma.run.update({
      where: { id: workerRun.id },
      data: { delegationId: frozenDelegation.id },
    });
    await prisma.delegationRoot.update({
      where: { rootTaskId: goal.rootTaskId },
      data: { reservedTokens: { increment: 10_000 }, activeDescendants: { increment: 1 } },
    });

    const revision = await submit(goal.id);
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "completed",
    );
    for (const runId of [staleRun.id, workerRun.id]) {
      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      expect(run.status).toBe("cancelled");
      const task = await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
      expect(task.status).toBe("cancelled");
    }
    const delegation = await prisma.delegation.findFirstOrThrow({
      where: { admissionKey: `freeze-fixture-${goal.id}` },
    });
    expect(delegation.status).toBe("cancelled");
    expect(delegation.result).toContain("reached owner review");
    const root = await prisma.delegationRoot.findUniqueOrThrow({
      where: { rootTaskId: goal.rootTaskId },
    });
    expect(root.reservedTokens).toBe(0);
    const event = await prisma.event.findFirstOrThrow({
      where: { type: "goal.submitted", payload: { path: ["goalId"], equals: goal.id } },
    });
    expect((event.payload as { frozenRunIds: string[] }).frozenRunIds.sort()).toEqual(
      [staleRun.id, workerRun.id].sort(),
    );

    // With the freeze drained, acceptance settles.
    await passConditions(goal.id, revision.id);
    await acceptGoal(prisma, actor, { goalId: goal.id, revisionId: revision.id });
    const settlement = await prisma.goalSettlement.findUniqueOrThrow({
      where: { goalId: goal.id },
    });
    expect(settlement.revisionId).toBe(revision.id);
    expect(settlement.reservedTokens).toBe(0);
  });

  it("resumes with a fresh run and open effects after a send-back", async () => {
    const goal = await createGoal();
    await submit(goal.id);
    const revision = await prisma.goalRevision.findFirstOrThrow({
      where: { goalId: goal.id },
      orderBy: { attempts: "desc" },
    });
    await rejectGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      reworkNotes: "Keep going",
    });
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "running",
    );
    const rework = await prisma.run.findFirstOrThrow({
      where: { goalId: goal.id, clientNonce: `goal-rework:${revision.id}` },
    });
    expect(rework.status).toBe("queued");

    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        prompt: "Fixture",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: task.id,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    const admitted = await admitGoalRunEffect(prisma, {
      spaceId,
      userId,
      goalId: goal.id,
      rootTaskId: goal.rootTaskId,
      runId: run.id,
      kind: "fixture_effect",
      idempotencyKey: `rework-effect-${goal.id}`,
      request: { value: 1 },
    });
    expect(admitted.ok).toBe(true);
  });

  it("refuses child admission, effect dispatch and peer wakes after the freeze", async () => {
    const goal = await createGoal();
    const parentRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: goal.rootTaskId,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        prompt: "Fixture",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: task.id,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    // While running, effect dispatch and peer wake binding are admitted.
    const admitted = await admitGoalRunEffect(prisma, {
      spaceId,
      userId,
      goalId: goal.id,
      rootTaskId: goal.rootTaskId,
      runId: run.id,
      kind: "fixture_effect",
      idempotencyKey: `open-effect-${goal.id}`,
      request: { value: 1 },
    });
    expect(admitted.ok).toBe(true);
    const wake = await prisma.botMessageWake.create({
      data: {
        spaceId,
        userId,
        goalId: goal.id,
        rootTaskId: goal.rootTaskId,
        recipientBotId: coordinatorBotId,
        recipientThreadId: goal.threadId,
        authorityFingerprint: "fixture-fingerprint",
        generation: 1,
        clientNonce: `freeze-wake-${goal.id}`,
      },
    });

    await submit(goal.id);

    // Child admission refuses with the delegation problem and touches nothing.
    await expect(
      prisma.$transaction((tx) =>
        admitDelegation(tx, {
          spaceId,
          userId,
          parentRunId: parentRun.id,
          actingBotId: workerBotId,
          actingName: "Worker",
          kind: "group-handoff",
          admissionKey: `frozen-child-${goal.id}`,
          prompt: "More work",
          snapshot: delegationSnapshot,
        }),
      ),
    ).rejects.toMatchObject({ problem: { code: "authority-exceeded" } });
    expect(
      await prisma.delegation.count({ where: { admissionKey: `frozen-child-${goal.id}` } }),
    ).toBe(0);

    // New effect dispatch is refused; the pre-freeze effect is reconciled, not duplicated.
    const late = await admitGoalRunEffect(prisma, {
      spaceId,
      userId,
      goalId: goal.id,
      rootTaskId: goal.rootTaskId,
      runId: run.id,
      kind: "fixture_effect",
      idempotencyKey: `late-effect-${goal.id}`,
      request: { value: 2 },
    });
    expect(late).toEqual({ ok: false, reason: "goal-frozen" });
    expect(await prisma.externalEffect.count({ where: { runId: run.id } })).toBe(1);

    // A pending peer wake cannot bind once the goal is frozen.
    const dispatched = await dispatchBotMessageWake(prisma, wake.id);
    expect(dispatched.runId).toBeNull();
    const cancelledWake = await prisma.botMessageWake.findUniqueOrThrow({ where: { id: wake.id } });
    expect(cancelledWake.state).toBe("cancelled");
  });

  it("serializes effect dispatch against the freeze: no effect slips past acceptance", async () => {
    for (let round = 0; round < 10; round++) {
      const goal = await createGoal();
      const task = await prisma.task.create({
        data: {
          spaceId,
          userId,
          botId: coordinatorBotId,
          threadId: goal.threadId,
          prompt: "Fixture",
          status: "completed",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId: coordinatorBotId,
          threadId: goal.threadId,
          taskId: task.id,
          status: "completed",
          trigger: "follow_up",
          goalId: goal.id,
          delegationRootTaskId: goal.rootTaskId,
        },
      });
      const attemptEffect = admitGoalRunEffect(prisma, {
        spaceId,
        userId,
        goalId: goal.id,
        rootTaskId: goal.rootTaskId,
        runId: run.id,
        kind: "fixture_effect",
        idempotencyKey: `race-effect-${goal.id}`,
        request: { round },
      });
      const [effect, frozen] = await Promise.allSettled([attemptEffect, submit(goal.id)]);
      expect(effect.status).toBe("fulfilled");
      if (effect.status !== "fulfilled") throw effect.reason;
      if (effect.value.ok) {
        // Admission won the root lock. Submission cannot snapshot a pending dispatch.
        expect(frozen.status).toBe("rejected");
        if (frozen.status === "rejected")
          expect(frozen.reason).toMatchObject({ reason: "effects-open" });
        expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
          "running",
        );
        expect(await prisma.goalRevision.count({ where: { goalId: goal.id } })).toBe(0);
        await prisma.externalEffect.update({
          where: { id: effect.value.effect.id },
          data: { status: "completed", result: { ok: true } },
        });
        await submit(goal.id);
      } else {
        expect(frozen.status).toBe("fulfilled");
      }
      const revision = await prisma.goalRevision.findFirstOrThrow({
        where: { goalId: goal.id },
        orderBy: { attempts: "desc" },
      });
      await passConditions(goal.id, revision.id);
      await acceptGoal(prisma, actor, { goalId: goal.id, revisionId: revision.id });
      expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
        "accepted",
      );
      expect(await prisma.goalSettlement.count({ where: { goalId: goal.id } })).toBe(1);
    }
  });

  it("refuses acceptance while a lease is live and settles after the lease drains", async () => {
    const goal = await createGoal();
    const revision = await submit(goal.id);
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        prompt: "Fixture",
        status: "running",
      },
    });
    const live = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: task.id,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await passConditions(goal.id, revision.id);
    await expect(
      acceptGoal(prisma, actor, { goalId: goal.id, revisionId: revision.id }),
    ).rejects.toThrow("A live execution");
    await prisma.run.update({
      where: { id: live.id },
      data: { status: "completed", leaseOwner: null, leaseExpiresAt: null },
    });
    const verdict = await acceptGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
    });
    expect(verdict.type).toBe("accept");
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "accepted",
    );
  });
  it("blocks submission before and during an approved replay on a second client", async () => {
    const goal = await createGoal();
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        prompt: "Replay fixture",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: task.id,
        status: "running",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
      },
    });
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: "fixture_effect",
        idempotencyKey: `pending-replay-${goal.id}`,
        status: "approved",
        request: {},
      },
    });
    const other = createDb(databaseUrl!);
    let release!: () => void;
    const pendingDispatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatch: Promise<unknown> | undefined;
    const trySubmit = () =>
      submitGoal(other.prisma, actor, {
        goalId: goal.id,
        summary: "Candidate",
        artifacts: [],
        reports: [],
      });
    try {
      await expect(trySubmit()).rejects.toMatchObject({ reason: "effects-open" });
      expect(
        await claimGoalRunEffect(prisma, {
          spaceId,
          userId,
          goalId: goal.id,
          rootTaskId: goal.rootTaskId,
          effectId: effect.id,
          from: "approved",
        }),
      ).toBe(true);
      // The fake dispatch remains in flight after admission, across a second connection's submit.
      dispatch = pendingDispatch.then(() =>
        prisma.externalEffect.update({
          where: { id: effect.id },
          data: { status: "completed", result: { ok: true } },
        }),
      );
      await expect(trySubmit()).rejects.toMatchObject({ reason: "effects-open" });
      expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
        "running",
      );
      expect(await prisma.goalRevision.count({ where: { goalId: goal.id } })).toBe(0);
      release();
      await dispatch;
      await expect(trySubmit()).resolves.toMatchObject({ summary: "Candidate" });
    } finally {
      release();
      await dispatch;
      await other.prisma.$disconnect();
      await other.pool.end();
    }
  });

  it("requires terminal attempts and requests to finish collecting without inventing unknown counts", async () => {
    const goal = await createGoal();
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        prompt: "Collection fixture",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        threadId: goal.threadId,
        taskId: task.id,
        status: "completed",
        trigger: "follow_up",
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
        startedAt: new Date(),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "completed", finishedAt: new Date() },
    });
    const usage = await prisma.usageRecord.create({
      data: {
        spaceId,
        userId,
        botId: coordinatorBotId,
        runId: run.id,
        threadId: goal.threadId,
        rootTaskId: goal.rootTaskId,
        provider: "fixture",
        model: "fixture",
        inputTokens: 0,
        outputTokens: 0,
        purpose: "main",
        coverage: "partial",
        requestKey: `unknown-request-${goal.id}`,
      },
    });
    const revision = await submit(goal.id);
    await passConditions(goal.id, revision.id);
    const accept = () => acceptGoal(prisma, actor, { goalId: goal.id, revisionId: revision.id });
    await expect(accept()).rejects.toMatchObject({ reason: "work-active" });
    await prisma.attempt.update({
      where: { id: attempt.id },
      data: { usageSettledAt: new Date() },
    });
    await expect(accept()).rejects.toMatchObject({ reason: "work-active" });
    await prisma.usageRecord.update({
      where: { id: usage.id },
      data: { collectionFinishedAt: new Date() },
    });
    await expect(accept()).resolves.toMatchObject({ type: "accept" });
    expect((await prisma.usageRecord.findUniqueOrThrow({ where: { id: usage.id } })).coverage).toBe(
      "partial",
    );
  });
});
