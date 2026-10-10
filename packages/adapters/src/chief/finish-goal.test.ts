import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { finishGoalFromRun } from "./report-goal-done.js";

const secret = "fixture-secret-7k2";
const now = new Date("2030-01-01T00:00:00.000Z");

function reviewStore() {
  const goal = {
    id: "goal-1",
    spaceId: "space-1",
    userId: "owner-1",
    threadId: "thread-1",
    rootTaskId: "root-1",
    groupId: "group-1",
    coordinatorBotId: "bot-1",
    doneWhen: [] as string[],
    status: "running",
  };
  const revisions: Array<{ summary: string } & Record<string, unknown>> = [];
  const matches = (where: {
    id?: string;
    spaceId?: string;
    userId?: string;
    coordinatorBotId?: string;
    threadId?: string;
    status?: string;
  }) =>
    (!where.id || where.id === goal.id) &&
    (!where.spaceId || where.spaceId === goal.spaceId) &&
    (!where.userId || where.userId === goal.userId) &&
    (!where.coordinatorBotId || where.coordinatorBotId === goal.coordinatorBotId) &&
    (!where.threadId || where.threadId === goal.threadId) &&
    (!where.status || where.status === goal.status);
  const tx = {
    $queryRaw: vi.fn(async () => []),
    teamGoal: {
      findFirst: vi.fn(async ({ where }: { where: Parameters<typeof matches>[0] }) =>
        matches(where) ? { ...goal } : null,
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
          if (goal.status !== where.status) return { count: 0 };
          goal.status = data.status;
          return { count: 1 };
        },
      ),
    },
    chatGroup: { findFirst: vi.fn(async () => ({ id: goal.groupId })) },
    delegation: { findMany: vi.fn(async () => []) },
    goalRevision: {
      count: vi.fn(async () => revisions.length),
      create: vi.fn(async ({ data }: { data: { summary: string } }) => {
        const revision = {
          ...data,
          id: `revision-${revisions.length + 1}`,
          createdAt: now,
        };
        revisions.push(revision);
        return revision;
      }),
    },
    delegationRoot: { findUnique: vi.fn(async () => ({ usedTokens: 4, reservedTokens: 0 })) },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: {
      create: vi.fn(async ({ data }: { data: { type: string } }) => ({
        id: "event-1",
        type: data.type,
        payload: {},
        threadId: goal.threadId,
        botId: goal.coordinatorBotId,
        runId: null,
      })),
    },
  };
  const prisma = {
    teamGoal: tx.teamGoal,
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, revisions };
}

describe("finish_goal summary redaction", () => {
  it("stores the redacted summary and never the secret", async () => {
    const store = reviewStore();
    const reported = await finishGoalFromRun(store.prisma, {
      goalId: "goal-1",
      spaceId: "space-1",
      userId: "owner-1",
      coordinatorBotId: "bot-1",
      threadId: "thread-1",
      summary: `The result used ${secret}.`,
      secrets: [secret],
    });
    expect(reported).toEqual({ ok: true, revisionId: "revision-1", status: "completed" });
    expect(store.revisions).toHaveLength(1);
    expect(store.revisions[0]?.summary).toBe("The result used [redacted].");
    expect(store.revisions[0]?.summary).not.toContain(secret);
    expect(JSON.stringify(store.revisions[0])).not.toContain(secret);
  });
});
