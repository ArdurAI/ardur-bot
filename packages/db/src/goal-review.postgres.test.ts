import type { Actor } from "@ardurbot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  acceptGoal,
  rejectGoal,
  reviewGoalCondition,
  submitGoal,
  submitGoalFromCoordinator,
} from "./goals.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("Goal owner review (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `goal-review-org-${suffix}`;
  const spaceId = `goal-review-space-${suffix}`;
  const userId = `goal-review-user-${suffix}`;
  const actor: Actor = { spaceId, userId, email: "owner@example.test", isDeploymentOwner: true };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
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
        name: "Goal review fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Goal review fixture" } },
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Goal review fixture", color: "ink" },
    });
    botId = bot.id;
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
        name: `Goal review fixture ${goalCount}`,
        coordinatorBotId: botId,
      },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    await prisma.chatGroupMember.create({ data: { groupId: group.id, botId } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId,
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
        coordinatorBotId: botId,
        rootTaskId: task.id,
        objective: "Review fixture",
        status: "running",
        tokenLimit: 100,
        perWorkerTokens: 10,
        maxConcurrent: 1,
        maxDescendants: 1,
        untilAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.delegationRoot.create({
      data: {
        rootTaskId: task.id,
        spaceId,
        userId,
        coordinatorBotId: botId,
        coordinatorThreadId: thread.id,
        tokenLimit: 100,
        deadlineAt: goal.untilAt,
      },
    });
    return goal;
  }

  it("keeps rejected and accepted submissions unchanged through rework", async () => {
    const goal = await createGoal();
    const submit = (summary: string) =>
      submitGoal(prisma, actor, {
        goalId: goal.id,
        summary,
        artifacts: [],
        reports: [],
      });
    const rev1 = await submit("First attempt");
    const snapshot = await prisma.goalRevision.findUniqueOrThrow({ where: { id: rev1.id } });
    expect(rev1.attempts).toBe(1);
    await expect(submit("Overwrite attempt")).rejects.toThrow("already submitted");
    const feedback = await rejectGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: rev1.id,
      reworkNotes: "Review again",
    });
    expect(feedback.type).toBe("reject");
    const rev2 = await submit("Second attempt");
    expect(rev2.attempts).toBe(2);
    await expect(
      acceptGoal(prisma, actor, {
        goalId: goal.id,
        revisionId: rev1.id,
      }),
    ).rejects.toThrow("not current");
    await reviewGoalCondition(prisma, actor, {
      goalId: goal.id,
      revisionId: rev2.id,
      conditionId: "cond-final",
      status: "pass",
    });
    const verdict = await acceptGoal(prisma, actor, { goalId: goal.id, revisionId: rev2.id });
    expect(verdict.type).toBe("accept");
    await expect(
      rejectGoal(prisma, actor, {
        goalId: goal.id,
        revisionId: rev2.id,
        reworkNotes: "Reopen",
      }),
    ).rejects.toThrow("already reviewed");
    expect(await prisma.goalRevision.findUnique({ where: { id: rev1.id } })).toEqual(snapshot);
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "accepted",
    );
  });

  it.each(["non-owner", "other-user", "other-space"] as const)(
    "refuses accept and reject from %s",
    async (kind) => {
      const goal = await createGoal();
      const revision = await submitGoal(prisma, actor, {
        goalId: goal.id,
        summary: "Candidate",
        artifacts: [],
        reports: [],
      });
      const outsider = {
        ...actor,
        ...(kind === "non-owner"
          ? { isDeploymentOwner: false }
          : kind === "other-user"
            ? { userId: "other-user" }
            : { spaceId: "other-space" }),
      };
      const input = { goalId: goal.id, revisionId: revision.id };
      await expect(acceptGoal(prisma, outsider, input)).rejects.toThrow();
      await expect(
        rejectGoal(prisma, outsider, { ...input, reworkNotes: "Reopen" }),
      ).rejects.toThrow();
      expect(await prisma.goalVerdict.count({ where: { goalId: goal.id } })).toBe(0);
    },
  );

  it("records one acceptance and event for two owner tabs and a retry", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const input = { goalId: goal.id, revisionId: revision.id };
    await reviewGoalCondition(prisma, actor, {
      ...input,
      conditionId: "cond-final",
      status: "pass",
    });
    const [first, second] = await Promise.all([
      acceptGoal(prisma, actor, input),
      acceptGoal(prisma, actor, input),
    ]);
    expect(second).toEqual(first);
    expect(await acceptGoal(prisma, actor, input)).toEqual(first);
    expect(await prisma.goalVerdict.count({ where: { goalId: goal.id, type: "accept" } })).toBe(1);
    expect(
      await prisma.event.count({
        where: {
          threadId: goal.threadId,
          type: "goal.accepted",
          payload: { path: ["goalId"], equals: goal.id },
        },
      }),
    ).toBe(1);
  });

  it("submits when the coordinator reports the project done", async () => {
    const goal = await createGoal();
    const revision = await submitGoalFromCoordinator(prisma, {
      goalId: goal.id,
      spaceId,
      userId,
      coordinatorBotId: goal.coordinatorBotId,
      threadId: goal.threadId,
      summary: "Coordinator result",
    });
    expect(revision.summary).toBe("Coordinator result");
    expect(revision.conditions).toEqual([
      expect.objectContaining({ id: "cond-final", status: "unknown" }),
    ]);
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "completed",
    );
    await expect(
      submitGoalFromCoordinator(prisma, {
        goalId: goal.id,
        spaceId,
        userId,
        coordinatorBotId: "other-bot",
        threadId: goal.threadId,
        summary: "Not the coordinator",
      }),
    ).rejects.toThrow();
    expect(await prisma.goalRevision.count({ where: { goalId: goal.id } })).toBe(1);
  });

  it("refuses acceptance until every condition passes", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const input = { goalId: goal.id, revisionId: revision.id };
    await expect(acceptGoal(prisma, actor, input)).rejects.toThrow("Every condition must pass");
    await reviewGoalCondition(prisma, actor, {
      ...input,
      conditionId: "cond-final",
      status: "fail",
    });
    await expect(acceptGoal(prisma, actor, input)).rejects.toThrow("Every condition must pass");
    await reviewGoalCondition(prisma, actor, {
      ...input,
      conditionId: "cond-final",
      status: "pass",
    });
    const accepted = await acceptGoal(prisma, actor, input);
    expect(await acceptGoal(prisma, actor, input)).toEqual(accepted);
    expect(await prisma.goalVerdict.count({ where: { goalId: goal.id } })).toBe(1);
  });

  it("wakes the coordinator once with the rework notes", async () => {
    const goal = await createGoal();
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [],
      reports: [],
    });
    const input = { goalId: goal.id, revisionId: revision.id, reworkNotes: "Review again" };
    await rejectGoal(prisma, actor, input);
    await rejectGoal(prisma, actor, input);
    const wakes = await prisma.run.findMany({
      where: { goalId: goal.id, clientNonce: `goal-rework:${revision.id}` },
    });
    expect(wakes).toHaveLength(1);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: wakes[0]!.taskId } });
    expect(task.prompt).toContain("Review again");
    expect((await prisma.teamGoal.findUniqueOrThrow({ where: { id: goal.id } })).status).toBe(
      "running",
    );
  });
});
