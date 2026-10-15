import type { Actor } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { getGoalRevision } from "./goals.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  userId: "owner-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

function revision(id: string, summary: string, attempts: number) {
  return {
    id,
    goalId: "goal-1",
    summary,
    conditions: [],
    artifacts: [],
    reports: [],
    attempts,
    accountingSnapshot: { usedTokens: 1, reservedTokens: 0 },
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

const newest = revision("rev-new", "Newest result", 2);
const recorded = revision("rev-old", "Recorded result", 1);

function prisma() {
  const goal = {
    id: "goal-1",
    spaceId: "space-1",
    userId: "owner-1",
    groupId: "group-1",
    threadId: "thread-1",
    coordinatorBotId: "bot-1",
    rootTaskId: "task-1",
    objective: "Ship the result",
    doneWhen: [],
    status: "running",
    tokenLimit: 600,
    perWorkerTokens: 30_000,
    maxConcurrent: 1,
    maxDescendants: 60,
    untilAt: new Date("2030-01-02T00:00:00.000Z"),
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    stoppedAt: null,
    boardWorkspaceId: null,
    boardItemId: null,
    revisions: [newest],
  };
  return {
    goalRevision: {
      findFirst: async ({
        where,
      }: {
        where: {
          id: string;
          goalId: string;
          goal: { groupId: string; spaceId: string; userId: string };
        };
      }) => {
        if (
          where.id !== recorded.id ||
          where.goalId !== "goal-1" ||
          where.goal.groupId !== "group-1" ||
          where.goal.spaceId !== actor.spaceId ||
          where.goal.userId !== actor.userId
        )
          return null;
        return recorded;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        teamGoal: { findFirst: async () => goal },
        delegationRoot: {
          findFirst: async () => ({ usedTokens: 10, reservedTokens: 0, tokenLimit: 600 }),
        },
        usageRecord: { findFirst: async () => null },
        run: { findFirst: async () => null },
        goalBoardDelivery: { findMany: async () => [] },
        goalSettlement: { findUnique: async () => null },
        goalPlanStep: { findMany: async () => [] },
      }),
  } as unknown as PrismaClient;
}

it("returns the named revision for the owner and refuses another owner", async () => {
  const view = await getGoalRevision(prisma(), actor, {
    groupId: "group-1",
    goalId: "goal-1",
    revisionId: "rev-old",
  });
  expect(view?.goal.currentRevision?.summary).toBe("Recorded result");
  expect(view?.goal.currentRevision?.id).toBe("rev-old");
  expect(view?.current).toBe(false);
  expect(view?.goal.currentRevision?.summary).not.toBe("Newest result");
  await expect(
    getGoalRevision(
      prisma(),
      { ...actor, userId: "other-owner" },
      {
        groupId: "group-1",
        goalId: "goal-1",
        revisionId: "rev-old",
      },
    ),
  ).resolves.toBeNull();
  await expect(
    getGoalRevision(
      prisma(),
      { ...actor, isDeploymentOwner: false },
      {
        groupId: "group-1",
        goalId: "goal-1",
        revisionId: "rev-old",
      },
    ),
  ).rejects.toBeInstanceOf(IsolationError);
});
