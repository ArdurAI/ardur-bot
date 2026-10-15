import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import {
  createDb,
  GoalPlanConflict,
  getGoal,
  listReadyGoalPlanSteps,
  loadGoalPlan,
  markGoalPlanStepDispatched,
  recordGoalPlanStepOutcome,
  settleGoalPlanStep,
  startGoal,
  submitGoal,
  updateGoalPlan,
} from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("Chief project plan (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `chief-plan-org-${suffix}`;
  const spaceId = `chief-plan-space-${suffix}`;
  const userId = `chief-plan-user-${suffix}`;
  const actor: Actor = { spaceId, userId, email: "owner@example.test", isDeploymentOwner: true };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let chiefBotId: string;
  let memberBotId: string;

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
        name: "Chief plan fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Chief plan fixture" } },
      },
    });
    chiefBotId = (
      await prisma.bot.create({ data: { spaceId, userId, name: "Chief", color: "ink" } })
    ).id;
    memberBotId = (
      await prisma.bot.create({ data: { spaceId, userId, name: "Writer", color: "ink" } })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.delete({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function runningGoal() {
    const created = await prisma.chatGroup.create({
      data: { spaceId, userId, name: `Chief plan ${Date.now()}`, coordinatorBotId: chiefBotId },
    });
    const thread = await prisma.thread.create({
      data: { spaceId, userId, groupId: created.id },
    });
    await prisma.chatGroupMember.create({ data: { groupId: created.id, botId: chiefBotId } });
    await prisma.chatGroupMember.create({ data: { groupId: created.id, botId: memberBotId } });
    const goal = await startGoal(prisma, actor, {
      groupId: created.id,
      objective: "Ship the quarterly report",
      doneWhen: ["Report accepted"],
    });
    return { groupId: created.id, threadId: thread.id, goalId: goal.id };
  }

  const scope = (threadId: string) => ({
    spaceId,
    userId,
    coordinatorBotId: chiefBotId,
    threadId,
  });

  function step(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      title: `Step ${id}`,
      ownerId: memberBotId,
      ownerIsUser: false,
      condition: "Records support it",
      prerequisiteIds: [],
      ...overrides,
    };
  }

  it("persists a validated plan, refuses cycles, bad owners and stale revisions", async () => {
    const room = await runningGoal();
    const saved = await updateGoalPlan(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        baseRevision: 1,
        steps: [step("one"), step("two", { prerequisiteIds: ["one"] })],
      },
    );
    expect(saved.plan?.revision).toBe(2);
    expect(saved.plan?.steps.map((entry) => entry.status)).toEqual(["pending", "pending"]);

    await expect(
      updateGoalPlan(
        prisma,
        { actor },
        {
          goalId: room.goalId,
          baseRevision: 1,
          steps: [step("one")],
        },
      ),
    ).rejects.toBeInstanceOf(GoalPlanConflict);

    await expect(
      updateGoalPlan(
        prisma,
        { actor },
        {
          goalId: room.goalId,
          baseRevision: 2,
          steps: [step("a", { prerequisiteIds: ["b"] }), step("b", { prerequisiteIds: ["a"] })],
        },
      ),
    ).rejects.toMatchObject({ reason: "dependency-cycle" });

    await expect(
      updateGoalPlan(
        prisma,
        { actor },
        {
          goalId: room.goalId,
          baseRevision: 2,
          steps: [step("a", { ownerId: "bot-stranger" })],
        },
      ),
    ).rejects.toMatchObject({ reason: "unknown-owner" });

    await expect(
      updateGoalPlan(
        prisma,
        { actor },
        {
          goalId: room.goalId,
          baseRevision: 2,
          steps: [step("a", { prerequisiteIds: ["ghost"] })],
        },
      ),
    ).rejects.toMatchObject({ reason: "prerequisite-missing" });
  });

  it("hands a ready step out exactly once and recovers after a restart", async () => {
    const room = await runningGoal();
    await updateGoalPlan(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        baseRevision: 1,
        steps: [step("one"), step("two", { prerequisiteIds: ["one"] })],
      },
    );
    const ready = await listReadyGoalPlanSteps(prisma, room.goalId);
    expect(ready.map((row) => row.clientId)).toEqual(["one"]);

    const claimed = await markGoalPlanStepDispatched(
      prisma as unknown as Parameters<typeof markGoalPlanStepDispatched>[0],
      {
        stepRowId: ready[0]!.id,
        runId: "run-one",
        delegationId: "delegation-one",
        at: new Date(),
      },
    );
    expect(claimed).toBe(true);
    // A duplicate handout for the same step loses the conditional claim.
    const duplicate = await markGoalPlanStepDispatched(
      prisma as unknown as Parameters<typeof markGoalPlanStepDispatched>[0],
      {
        stepRowId: ready[0]!.id,
        runId: "run-two",
        delegationId: "delegation-two",
        at: new Date(),
      },
    );
    expect(duplicate).toBe(false);

    // Restart sweep: the dispatched step is gone; the waiting one appears only
    // after its prerequisite is done.
    expect((await listReadyGoalPlanSteps(prisma, room.goalId)).map((row) => row.clientId)).toEqual(
      [],
    );
    await prisma.goalPlanStep.updateMany({
      where: { goalId: room.goalId, clientId: "one" },
      data: { status: "done" },
    });
    expect((await listReadyGoalPlanSteps(prisma, room.goalId)).map((row) => row.clientId)).toEqual([
      "two",
    ]);
  });

  it("derives blocked steps from cancelled prerequisites and keeps the record", async () => {
    const room = await runningGoal();
    await updateGoalPlan(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        baseRevision: 1,
        steps: [step("one"), step("two", { prerequisiteIds: ["one"] })],
      },
    );
    await settleGoalPlanStep(
      prisma,
      { actor },
      { goalId: room.goalId, stepId: "one", baseRevision: 2, action: "cancel" },
    );
    // Dropping the cancelled step from the plan keeps it cancelled (never
    // deleted) and leaves its dependent blocked.
    const saved = await updateGoalPlan(
      prisma,
      { actor },
      { goalId: room.goalId, baseRevision: 3, steps: [step("two", { prerequisiteIds: ["one"] })] },
    );
    const statuses = Object.fromEntries(
      saved.plan?.steps.map((entry) => [entry.id, entry.status]) ?? [],
    );
    expect(statuses).toEqual({ one: "cancelled", two: "blocked" });
    expect(await listReadyGoalPlanSteps(prisma, room.goalId)).toEqual([]);
  });

  it("records outcomes tied to goal records and refuses model-text-only completion", async () => {
    const room = await runningGoal();
    await updateGoalPlan(
      prisma,
      { actor },
      { goalId: room.goalId, baseRevision: 1, steps: [step("one")] },
    );
    await markGoalPlanStepDispatched(
      prisma as unknown as Parameters<typeof markGoalPlanStepDispatched>[0],
      {
        stepRowId: (await prisma.goalPlanStep.findFirstOrThrow({ where: { clientId: "one" } })).id,
        runId: "run-one",
        delegationId: "delegation-one",
        at: new Date(),
      },
    );

    // The coordinator path names no record: refused.
    await expect(
      recordGoalPlanStepOutcome(
        prisma,
        { scope: scope(room.threadId), goalId: room.goalId },
        { stepId: "one", baseRevision: 2, support: [] },
      ),
    ).rejects.toMatchObject({ reason: "missing-support" });

    // A run from outside the goal's work is not a record of this goal.
    const foreignTask = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: memberBotId,
        threadId: room.threadId,
        prompt: "Fixture",
        status: "completed",
      },
    });
    const foreignRun = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: memberBotId,
        threadId: room.threadId,
        taskId: foreignTask.id,
        status: "completed",
        trigger: "manual",
      },
    });
    await expect(
      recordGoalPlanStepOutcome(
        prisma,
        { scope: scope(room.threadId), goalId: room.goalId },
        {
          stepId: "one",
          baseRevision: 2,
          support: [{ kind: "run", recordId: foreignRun.id, revision: null }],
        },
      ),
    ).rejects.toMatchObject({ reason: "run-outside-goal" });

    // The owner's attestation on the member's step is the recorded outcome.
    const saved = await recordGoalPlanStepOutcome(
      prisma,
      { actor },
      { goalId: room.goalId, stepId: "one", baseRevision: 2, support: [] },
    );
    const done = saved.plan?.steps.find((entry) => entry.id === "one");
    expect(done?.status).toBe("done");
    expect(done?.outcome).toMatchObject({ actorId: userId });
  });

  it("reopens finished work, clearing outcome and dispatch for a fresh handout", async () => {
    const room = await runningGoal();
    await updateGoalPlan(
      prisma,
      { actor },
      { goalId: room.goalId, baseRevision: 1, steps: [step("one")] },
    );
    await markGoalPlanStepDispatched(
      prisma as unknown as Parameters<typeof markGoalPlanStepDispatched>[0],
      {
        stepRowId: (await prisma.goalPlanStep.findFirstOrThrow({ where: { clientId: "one" } })).id,
        runId: "run-one",
        delegationId: "delegation-one",
        at: new Date(),
      },
    );
    await recordGoalPlanStepOutcome(
      prisma,
      { actor },
      { goalId: room.goalId, stepId: "one", baseRevision: 2, support: [] },
    );
    const reopened = await settleGoalPlanStep(
      prisma,
      { actor },
      { goalId: room.goalId, stepId: "one", baseRevision: 3, action: "reopen" },
    );
    const entry = reopened.plan?.steps.find((item) => item.id === "one");
    expect(entry?.status).toBe("pending");
    expect(entry?.outcome).toBeNull();
    expect(entry?.dispatch).toBeNull();
    const row = await prisma.goalPlanStep.findFirstOrThrow({
      where: { clientId: "one", goalId: room.goalId },
    });
    expect(row.dispatchRunId).toBeNull();
    expect(row.outcome).toBeNull();
    // The cleared dispatch marker makes the step ready for a fresh handout.
    expect(
      (await listReadyGoalPlanSteps(prisma, room.goalId)).map((item) => item.clientId),
    ).toEqual(["one"]);
  });

  it("keeps the submitted step order across plan updates and goal reads", async () => {
    const room = await runningGoal();
    await updateGoalPlan(
      prisma,
      { actor },
      { goalId: room.goalId, baseRevision: 1, steps: [step("one"), step("two")] },
    );
    const swapped = await updateGoalPlan(
      prisma,
      { actor },
      { goalId: room.goalId, baseRevision: 2, steps: [step("two"), step("one")] },
    );
    expect(swapped.plan?.steps.map((entry) => entry.id)).toEqual(["two", "one"]);
    const viewed = await getGoal(prisma, actor, room.groupId);
    expect(viewed?.plan?.steps.map((entry) => entry.id)).toEqual(["two", "one"]);
    expect((await loadGoalPlan(prisma, room.goalId))?.steps.map((entry) => entry.id)).toEqual([
      "two",
      "one",
    ]);
    expect(
      (await listReadyGoalPlanSteps(prisma, room.goalId)).map((entry) => entry.clientId),
    ).toEqual(["two", "one"]);
    // Tied positions use row id, never creation time or query-plan accident.
    await prisma.goalPlanStep.updateMany({ where: { goalId: room.goalId }, data: { position: 0 } });
    const expected = await prisma.goalPlanStep.findMany({
      where: { goalId: room.goalId },
      orderBy: { id: "asc" },
    });
    expect((await loadGoalPlan(prisma, room.goalId))?.steps.map((entry) => entry.id)).toEqual(
      expected.map((entry) => entry.clientId),
    );
    expect((await listReadyGoalPlanSteps(prisma, room.goalId)).map((entry) => entry.id)).toEqual(
      expected.map((entry) => entry.id),
    );
  });

  it("refuses unsafe ids at the storage boundary without saving a plan or event", async () => {
    const room = await runningGoal();
    const eventsBefore = await prisma.event.count({ where: { threadId: room.threadId } });
    for (const invalid of [step("unsafe_id"), step("safe", { prerequisiteIds: ["unsafe_id"] })]) {
      await expect(
        updateGoalPlan(
          prisma,
          { actor },
          {
            goalId: room.goalId,
            baseRevision: 1,
            steps: [invalid],
          },
        ),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(await prisma.goalPlanStep.count({ where: { goalId: room.goalId } })).toBe(0);
    expect(await prisma.event.count({ where: { threadId: room.threadId } })).toBe(eventsBefore);
  });

  it("keeps completion proof bound to its definition until explicitly reopened", async () => {
    const room = await runningGoal();
    await updateGoalPlan(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        baseRevision: 1,
        steps: [
          step("base", { ownerId: chiefBotId }),
          step("draft", { condition: "Draft exists" }),
          step("review", { prerequisiteIds: ["draft"] }),
        ],
      },
    );
    await recordGoalPlanStepOutcome(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        stepId: "draft",
        baseRevision: 2,
        support: [],
      },
    );
    const before = await prisma.goalPlanStep.findMany({
      where: { goalId: room.goalId },
      orderBy: { id: "asc" },
    });
    for (const change of [
      { condition: "Production deployment verified" },
      { ownerId: chiefBotId },
      { prerequisiteIds: ["base"] },
      { title: "Publish the report" },
    ]) {
      await expect(
        updateGoalPlan(
          prisma,
          { actor },
          {
            goalId: room.goalId,
            baseRevision: 3,
            steps: [step("draft", { condition: "Draft exists", ...change })],
          },
        ),
      ).rejects.toMatchObject({ reason: "step-settled" });
    }
    expect(
      await prisma.goalPlanStep.findMany({
        where: { goalId: room.goalId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    expect((await loadGoalPlan(prisma, room.goalId))?.revision).toBe(3);
    await settleGoalPlanStep(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        stepId: "draft",
        baseRevision: 3,
        action: "reopen",
      },
    );
    const changed = await updateGoalPlan(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        baseRevision: 4,
        steps: [
          step("draft", { condition: "Production deployment verified" }),
          step("review", { prerequisiteIds: ["draft"] }),
        ],
      },
    );
    expect(changed.plan?.steps.find((entry) => entry.id === "draft")).toMatchObject({
      status: "pending",
      outcome: null,
      condition: "Production deployment verified",
    });
    expect(
      (await listReadyGoalPlanSteps(prisma, room.goalId)).map((entry) => entry.clientId),
    ).toEqual(["draft"]);
  });

  it("accepts an unchanged done step after the secret list grows past its stored text", async () => {
    const room = await runningGoal();
    const secret = "fixture-secret-9f3";
    // Stored before the chief's run knew the secret, so the durable title
    // keeps it in clear.
    await updateGoalPlan(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        baseRevision: 1,
        steps: [step("draft", { title: `Ship with ${secret}`, condition: "Draft exists" })],
      },
    );
    await recordGoalPlanStepOutcome(
      prisma,
      { actor },
      { goalId: room.goalId, stepId: "draft", baseRevision: 2, support: [] },
    );
    const chief = { scope: scope(room.threadId), goalId: room.goalId, secrets: [secret] };
    const carried = await updateGoalPlan(prisma, chief, {
      baseRevision: 3,
      steps: [step("draft", { title: "Ship with [redacted]", condition: "Draft exists" })],
    });
    expect(carried.plan?.steps.find((entry) => entry.id === "draft")).toMatchObject({
      status: "done",
      title: "Ship with [redacted]",
    });
    await expect(
      updateGoalPlan(prisma, chief, {
        baseRevision: 4,
        steps: [step("draft", { title: "Ship with [redacted]", condition: "Published" })],
      }),
    ).rejects.toMatchObject({ reason: "step-settled" });
  });

  it("projects the plan on goal reads and freezes it with the goal", async () => {
    const room = await runningGoal();
    await updateGoalPlan(
      prisma,
      { actor },
      {
        goalId: room.goalId,
        baseRevision: 1,
        steps: [
          step("mine", { ownerId: userId, ownerIsUser: true }),
          step("chiefs", { ownerId: chiefBotId }),
        ],
      },
    );
    const viewed = await getGoal(prisma, actor, room.groupId);
    expect(viewed?.plan?.revision).toBe(2);
    // Person-owned and coordinator-owned steps are never auto-dispatched.
    expect(await listReadyGoalPlanSteps(prisma, room.goalId)).toEqual([]);

    await submitGoal(prisma, actor, {
      goalId: room.goalId,
      summary: "Done",
      artifacts: [],
      reports: [],
    });
    await expect(
      updateGoalPlan(
        prisma,
        { actor },
        {
          goalId: room.goalId,
          baseRevision: 2,
          steps: [step("mine", { ownerId: userId, ownerIsUser: true })],
        },
      ),
    ).rejects.toMatchObject({ reason: "not-running" });
  });
});
