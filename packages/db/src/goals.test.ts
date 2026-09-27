import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  goalExhaustionReason,
  reconcileGoalExhaustion,
  startGoal,
  wakeGoalCoordinatorForDelegation,
} from "./goals.js";

const now = new Date("2030-01-01T00:00:00.000Z");

describe("goal scheduling", () => {
  it("recognizes a cancelled root and a root deadline even before the goal deadline", () => {
    const goal = { untilAt: new Date("2030-01-02T00:00:00.000Z"), tokenLimit: 100 };
    expect(
      goalExhaustionReason(
        goal,
        {
          usedTokens: 0,
          tokenLimit: 100,
          deadlineAt: new Date("2020-01-01T00:00:00.000Z"),
          cancelRequestedAt: null,
        },
        now,
      ),
    ).toBe("deadline");
    expect(
      goalExhaustionReason(
        goal,
        {
          usedTokens: 0,
          tokenLimit: 100,
          deadlineAt: goal.untilAt,
          cancelRequestedAt: now,
        },
        now,
      ),
    ).toBe("cancelled");
  });
  it("persists the initial coordinator run with the goal root and a retry nonce", async () => {
    const runCreate = vi.fn(async () => ({ id: "run-start" }));
    const group = {
      id: "group-1",
      coordinatorBotId: "bot-1",
      thread: { id: "thread-1" },
      members: [{ botId: "bot-1", bot: { archivedAt: null } }],
    };
    const goal = {
      id: "goal-1",
      spaceId: "space-1",
      userId: "owner-1",
      groupId: group.id,
      threadId: group.thread.id,
      coordinatorBotId: "bot-1",
      rootTaskId: "task-root",
      objective: "Review the repository",
      doneWhen: ["Post a summary"],
      status: "running",
      tokenLimit: 600_000,
      perWorkerTokens: 30_000,
      maxConcurrent: 1,
      maxDescendants: 60,
      untilAt: new Date("2030-01-02T00:00:00.000Z"),
      createdAt: now,
      stoppedAt: null,
    };
    const tx = {
      chatGroup: { findFirst: vi.fn(async () => group) },
      $queryRaw: vi.fn(async () => []),
      teamGoal: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => goal),
      },
      task: { create: vi.fn(async () => ({ id: goal.rootTaskId })) },
      delegationRoot: { create: vi.fn(async () => ({})) },
      run: { create: runCreate },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      teamGoal: { findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(goal) },
      delegationRoot: { findUnique: vi.fn(async () => ({ usedTokens: 0 })) },
    } as unknown as PrismaClient;
    const result = await startGoal(
      prisma,
      { spaceId: "space-1", userId: "owner-1", isDeploymentOwner: true } as never,
      { groupId: group.id, objective: goal.objective, doneWhen: goal.doneWhen },
    );
    expect(result.id).toBe(goal.id);
    expect(runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: goal.rootTaskId,
        goalId: goal.id,
        delegationRootTaskId: goal.rootTaskId,
        trigger: "follow_up",
        clientNonce: `goal-start:${goal.id}`,
        status: "queued",
      }),
    });
  });

  it("marks a spent goal exhausted and records the transition only once", async () => {
    let status = "running";
    const updateMany = vi.fn(async () => {
      status = "exhausted";
      return { count: 1 };
    });
    const eventCreate = vi.fn(async () => ({ seq: 1 }));
    const tx = {
      teamGoal: {
        findUnique: vi.fn(async () => ({
          id: "goal-1",
          rootTaskId: "task-root",
          spaceId: "space-1",
          threadId: "thread-1",
          coordinatorBotId: "bot-1",
          status,
          untilAt: new Date("2030-01-01T00:00:00.000Z"),
          tokenLimit: 100,
        })),
        updateMany,
      },
      delegationRoot: {
        findUnique: vi.fn(async () => ({ usedTokens: 100, cancelRequestedAt: null })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: eventCreate },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    expect(await reconcileGoalExhaustion(prisma, "goal-1")).toBe("tokens");
    expect(await reconcileGoalExhaustion(prisma, "goal-1")).toBeNull();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(eventCreate).toHaveBeenCalledTimes(1);
    expect(eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "goal.exhausted",
        payload: { goalId: "goal-1", reason: "tokens" },
      }),
    });
  });

  it("waits for thread finalization before deciding whether to steer or queue a wake", async () => {
    let active = true;
    const runCreate = vi.fn(async () => ({ id: "run-wake" }));
    const steeringCreate = vi.fn(async () => ({}));
    const tx = {
      delegation: {
        findUnique: vi.fn(async () => ({ rootTaskId: "task-root" })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: "delegation-1",
          rootTaskId: "task-root",
          spaceId: "space-1",
          userId: "owner-1",
          kind: "group-handoff",
          status: "completed",
          coordinatorWokenAt: null,
          summaryMessageId: "message-summary",
          actingName: "Reviewer",
        })),
        update: vi.fn(async () => ({})),
      },
      $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
        if (query[0]?.includes("threads")) active = false;
        return [];
      }),
      teamGoal: {
        findUnique: vi.fn(async () => ({
          id: "goal-1",
          rootTaskId: "task-root",
          spaceId: "space-1",
          userId: "owner-1",
          groupId: "group-1",
          threadId: "thread-1",
          coordinatorBotId: "bot-1",
          status: "running",
          untilAt: new Date("2030-01-01T00:00:00.000Z"),
          objective: "Review",
        })),
      },
      delegationRoot: { findUniqueOrThrow: vi.fn(async () => ({ cancelRequestedAt: null })) },
      chatGroup: { findFirst: vi.fn(async () => ({ id: "group-1" })) },
      run: {
        findFirst: vi.fn(async () => (active ? { id: "run-finalizing" } : null)),
        create: runCreate,
      },
      steeringMessage: { create: steeringCreate },
      task: { create: vi.fn(async () => ({ id: "task-wake" })) },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    await wakeGoalCoordinatorForDelegation(prisma, "delegation-1");
    expect(runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientNonce: "goal-wake:delegation-1" }),
    });
    expect(steeringCreate).not.toHaveBeenCalled();
  });
});
