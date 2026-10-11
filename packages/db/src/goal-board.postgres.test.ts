import type { Actor } from "@ardurbot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { acceptGoal, linkGoal, rejectGoal, startGoal, submitGoal } from "./goals.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("Goal board delivery outbox (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `goal-board-org-${suffix}`;
  const spaceId = `goal-board-space-${suffix}`;
  const userId = `goal-board-user-${suffix}`;
  const actor: Actor = { spaceId, userId, email: "owner@example.test", isDeploymentOwner: true };
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let workspaceId: string;

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
        name: "Goal board fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Goal board fixture" } },
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Goal board fixture", color: "ink" },
    });
    botId = bot.id;
    const workspace = await prisma.boardWorkspace.create({
      data: {
        spaceId,
        ownerUserId: userId,
        kind: "space",
        path: `goal-board-${suffix}`,
        prefix: "gb",
        name: "Goal board fixture",
      },
    });
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.delete({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function group() {
    const created = await prisma.chatGroup.create({
      data: { spaceId, userId, name: `Goal board ${Date.now()}`, coordinatorBotId: botId },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: created.id } });
    await prisma.chatGroupMember.create({ data: { groupId: created.id, botId } });
    return { groupId: created.id, threadId: thread.id };
  }

  it("stores one owner link and refuses a workspace from another space", async () => {
    const other = await prisma.organization.create({
      data: {
        id: `${organizationId}-other`,
        name: "Other",
        slug: `${organizationId}-other`,
        createdAt: new Date(),
        spaces: { create: { id: `${spaceId}-other`, name: "Other" } },
      },
    });
    const foreign = await prisma.boardWorkspace.create({
      data: {
        spaceId: `${spaceId}-other`,
        ownerUserId: userId,
        kind: "space",
        path: `other-${suffix}`,
        prefix: "ot",
      },
    });
    const room = await group();
    await expect(
      startGoal(prisma, actor, {
        groupId: room.groupId,
        objective: "Review fixture",
        doneWhen: [],
        boardWorkspaceId: foreign.id,
        boardItemId: "board-a",
      }),
    ).rejects.toThrow();
    const started = await startGoal(prisma, actor, {
      groupId: room.groupId,
      objective: "Review fixture",
      doneWhen: [],
      boardWorkspaceId: workspaceId,
      boardItemId: "board-a",
    });
    expect(started.boardWorkspaceId).toBe(workspaceId);
    expect(started.boardItemId).toBe("board-a");
    await expect(
      linkGoal(
        prisma,
        { ...actor, isDeploymentOwner: false },
        {
          goalId: started.id,
          boardWorkspaceId: null,
          boardItemId: null,
        },
      ),
    ).rejects.toThrow();
    await prisma.organization.delete({ where: { id: other.id } });
  });

  it("inserts one completed row with the result and one accepted row on acceptance", async () => {
    const room = await group();
    const goal = await prisma.teamGoal.create({
      data: {
        spaceId,
        userId,
        groupId: room.groupId,
        threadId: room.threadId,
        coordinatorBotId: botId,
        rootTaskId: (
          await prisma.task.create({
            data: {
              spaceId,
              userId,
              botId,
              threadId: room.threadId,
              prompt: "Fixture",
              status: "completed",
            },
          })
        ).id,
        objective: "Review fixture",
        status: "running",
        tokenLimit: 100,
        perWorkerTokens: 10,
        maxConcurrent: 1,
        maxDescendants: 1,
        untilAt: new Date(Date.now() + 60_000),
        boardWorkspaceId: workspaceId,
        boardItemId: "board-a",
      },
    });
    await prisma.delegationRoot.create({
      data: {
        rootTaskId: goal.rootTaskId,
        spaceId,
        userId,
        coordinatorBotId: botId,
        coordinatorThreadId: room.threadId,
        tokenLimit: 100,
        deadlineAt: goal.untilAt,
      },
    });
    const revision = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Ready",
      artifacts: [],
      reports: [],
    });
    const completed = await prisma.goalBoardDelivery.findMany({ where: { goalId: goal.id } });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      revisionId: revision.id,
      transition: "completed",
      state: "pending",
      workspaceId,
      itemId: "board-a",
    });
    expect(completed[0]?.commentText).toContain("Goal completed");
    expect(completed[0]?.commentText).toContain(revision.id);
    await rejectGoal(prisma, actor, {
      goalId: goal.id,
      revisionId: revision.id,
      reworkNotes: "Not yet",
    });
    expect(
      await prisma.goalBoardDelivery.count({ where: { goalId: goal.id, transition: "accepted" } }),
    ).toBe(0);
    const next = await submitGoal(prisma, actor, {
      goalId: goal.id,
      summary: "Ready again",
      artifacts: [],
      reports: [],
    });
    await prisma.goalRevision.update({
      where: { id: next.id },
      data: {
        conditions: [
          {
            id: "cond-final",
            description: "goal.final-owner-review",
            status: "pass",
            actorId: userId,
            reason: null,
            evidenceId: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await acceptGoal(prisma, actor, { goalId: goal.id, revisionId: next.id });
    const rows = await prisma.goalBoardDelivery.findMany({
      where: { goalId: goal.id },
      orderBy: { transition: "asc" },
    });
    expect(rows.map((item) => item.transition).sort()).toEqual([
      "accepted",
      "completed",
      "completed",
    ]);
    expect(rows.filter((item) => item.transition === "accepted")).toHaveLength(1);
    expect(rows.find((item) => item.transition === "accepted")?.revisionId).toBe(next.id);
  });
});
