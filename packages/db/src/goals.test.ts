import type { Actor } from "@ardurbot/contracts";
import { GOAL_FINAL_REVIEW_DESCRIPTION } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  acceptGoal,
  admitGoalRunEffect,
  cancelRunHeldByFrozenGoal,
  claimGoalRunEffect,
  getGoal,
  goalExhaustionReason,
  isGoalRunEffectFrozen,
  reconcileGoalExhaustion,
  rejectGoal,
  reviewGoalCondition,
  startGoal,
  submitGoal,
  submitGoalFromCoordinator,
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
      revisions: [],
    };
    const tx = {
      chatGroup: { findFirst: vi.fn(async () => group) },
      $queryRaw: vi.fn(async () => []),
      teamGoal: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(goal),
        create: vi.fn(async () => goal),
      },
      task: { create: vi.fn(async () => ({ id: goal.rootTaskId })) },
      delegationRoot: {
        create: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => ({
          usedTokens: 0,
          reservedTokens: 0,
          tokenLimit: goal.tokenLimit,
        })),
      },
      usageRecord: { findFirst: vi.fn(async () => null) },
      goalSettlement: { findUnique: vi.fn(async () => null) },
      run: { create: runCreate, findFirst: vi.fn(async () => null) },
      goalBoardDelivery: { findMany: vi.fn(async () => []) },
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
    let cancelRequestedAt: Date | null = null;
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
          userId: "owner-1",
          threadId: "thread-1",
          coordinatorBotId: "bot-1",
          status,
          untilAt: new Date("2030-01-01T00:00:00.000Z"),
          tokenLimit: 100,
        })),
        updateMany,
      },
      delegationRoot: {
        findUnique: vi.fn(async () => ({ usedTokens: 100, cancelRequestedAt })),
        findUniqueOrThrow: vi.fn(async () => ({ coordinatorThreadId: "thread-1" })),
        findFirstOrThrow: vi.fn(async () => ({ rootTaskId: "task-root", cancelRequestedAt })),
        update: vi.fn(async ({ data }: { data: { cancelRequestedAt: Date } }) => {
          cancelRequestedAt = data.cancelRequestedAt;
          return {};
        }),
      },
      delegation: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({})) },
      run: { updateMany: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async () => []),
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: eventCreate },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    expect(await reconcileGoalExhaustion(prisma, "goal-1")).toBe("tokens");
    expect(cancelRequestedAt).toBeInstanceOf(Date);
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

  it.each(["running", "completed", "accepted"])(
    "checks %s goal state after locking before a coordinator wake",
    async (status) => {
      let goalStatus = "running";
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
          if (query[0]?.includes("tasks")) goalStatus = status;
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
            status: goalStatus,
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
      const result = await wakeGoalCoordinatorForDelegation(prisma, "delegation-1");
      if (status !== "running") {
        expect(result).toBeNull();
        expect(runCreate).not.toHaveBeenCalled();
        expect(tx.task.create).not.toHaveBeenCalled();
        expect(tx.delegation.update).toHaveBeenCalledWith({
          where: { id: "delegation-1" },
          data: { coordinatorWokenAt: expect.any(Date) },
        });
        expect(tx.event.create).not.toHaveBeenCalled();
        expect(steeringCreate).not.toHaveBeenCalled();
        return;
      }
      expect(runCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ clientNonce: "goal-wake:delegation-1" }),
      });
      expect(steeringCreate).not.toHaveBeenCalled();
    },
  );
});

const owner: Actor = {
  spaceId: "space-1",
  userId: "owner-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

function reviewFixture() {
  const goal = {
    id: "goal-1",
    spaceId: owner.spaceId,
    userId: owner.userId,
    threadId: "thread-1",
    rootTaskId: "root-1",
    groupId: "group-1",
    coordinatorBotId: "bot-1",
    doneWhen: [],
    objective: "Review",
    tokenLimit: 100,
    perWorkerTokens: 10,
    maxConcurrent: 1,
    maxDescendants: 1,
    status: "running",
    untilAt: new Date("2030-01-02T00:00:00.000Z"),
    createdAt: now,
    stoppedAt: null,
    boardWorkspaceId: null as string | null,
    boardItemId: null as string | null,
  };
  const revisions: Array<{
    id: string;
    goalId: string;
    summary: string;
    conditions: unknown;
    artifacts: unknown;
    reports: unknown;
    attempts: number;
    accountingSnapshot: unknown;
    createdAt: Date;
  }> = [];
  const verdicts: Array<{
    id: string;
    goalId: string;
    revisionId: string;
    actorId: string;
    type: string;
    reworkNotes: string | null;
    createdAt: Date;
  }> = [];
  const root = { usedTokens: 10, reservedTokens: 0, tokenLimit: 100 };
  const scopedGoal = vi.fn(
    async ({
      where,
    }: {
      where: {
        spaceId?: string;
        userId?: string;
        coordinatorBotId?: string;
        threadId?: string;
        status?: string;
        id?: string;
      };
    }) =>
      (where.spaceId && where.spaceId !== owner.spaceId) ||
      (where.userId && where.userId !== owner.userId) ||
      (where.coordinatorBotId && where.coordinatorBotId !== goal.coordinatorBotId) ||
      (where.threadId && where.threadId !== goal.threadId) ||
      (where.status && where.status !== goal.status) ||
      (where.id && where.id !== goal.id)
        ? null
        : { ...goal, revisions: revisions.slice(-1) },
  );
  const tx = {
    $queryRaw: vi.fn(async () => []),
    teamGoal: {
      findFirst: scopedGoal,
      findUniqueOrThrow: vi.fn(async () => ({ ...goal })),
      updateMany: vi.fn(
        async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
          if (goal.status !== where.status) return { count: 0 };
          goal.status = data.status;
          return { count: 1 };
        },
      ),
      update: vi.fn(async ({ data }: { data: { status: string } }) => {
        goal.status = data.status;
        return goal;
      }),
    },
    goalRevision: {
      count: vi.fn(async () => revisions.length),
      findFirst: vi.fn(async () => revisions.at(-1) ?? null),
      create: vi.fn(
        async ({ data }: { data: Omit<(typeof revisions)[number], "id" | "createdAt"> }) => {
          const revision = { ...data, id: `revision-${revisions.length + 1}`, createdAt: now };
          revisions.push(structuredClone(revision));
          return revision;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { conditions: unknown } }) => {
          const revision = revisions.find((item) => item.id === where.id);
          if (!revision) throw new Error("missing revision");
          revision.conditions = data.conditions;
          return revision;
        },
      ),
    },
    goalVerdict: {
      findFirst: vi.fn(
        async ({ where }: { where: { revisionId: string } }) =>
          verdicts.find((verdict) => verdict.revisionId === where.revisionId) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: Omit<(typeof verdicts)[number], "id" | "createdAt"> }) => {
          const verdict = { ...data, id: `verdict-${verdicts.length + 1}`, createdAt: now };
          verdicts.push(verdict);
          return verdict;
        },
      ),
    },
    delegationRoot: { findUnique: vi.fn(async () => root), findFirst: vi.fn(async () => root) },
    delegation: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    chatGroup: { findFirst: vi.fn(async () => ({ id: goal.groupId })) },
    task: {
      create: vi.fn(async () => ({ id: "task-rework" })),
      updateMany: vi.fn(async () => ({})),
    },
    usageRecord: { findFirst: vi.fn(async () => null) },
    attempt: { updateMany: vi.fn(async () => ({})), findFirst: vi.fn(async () => null as unknown) },
    run: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._args: unknown[]) => null as unknown),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({ id: "run-rework" })),
    },
    externalEffect: {
      findFirst: vi.fn(async (_args: { where: { status: unknown } }) => null as unknown),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    goalSettlement: {
      create: vi.fn(
        async ({ data }: { data: { goalId: string; revisionId: string; usedTokens: number } }) => ({
          ...data,
          id: "settlement-1",
          createdAt: now,
        }),
      ),
      findUnique: vi.fn(async () => null as unknown),
    },
    goalSettlementDiscrepancy: {
      aggregate: vi.fn(async () => ({ _sum: { tokens: 0 }, _count: 0 })),
    },
    goalBoardDelivery: {
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      count: vi.fn(async () => 0),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
  };
  const prisma = {
    teamGoal: tx.teamGoal,
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      const before = structuredClone({ goal, revisions, verdicts });
      try {
        return await fn(tx);
      } catch (error) {
        Object.assign(goal, before.goal);
        revisions.splice(0, revisions.length, ...before.revisions);
        verdicts.splice(0, verdicts.length, ...before.verdicts);
        throw error;
      }
    },
  } as unknown as PrismaClient;
  const submit = () =>
    submitGoal(prisma, owner, {
      goalId: goal.id,
      summary: "Candidate",
      artifacts: [{ id: "artifact-1", hash: "fixture-hash" }],
      reports: [{ id: "report-1", revision: "fixture-revision" }],
    });
  return { prisma, tx, goal, revisions, verdicts, root, submit };
}

describe("goal owner review", () => {
  it("refuses submission by a non-owner or an owner outside the goal scope", async () => {
    const fixture = reviewFixture();
    for (const actor of [
      { ...owner, isDeploymentOwner: false },
      { ...owner, userId: "other-user" },
      { ...owner, spaceId: "other-space" },
    ]) {
      await expect(
        submitGoal(fixture.prisma, actor, {
          goalId: fixture.goal.id,
          summary: "Candidate",
          artifacts: [],
          reports: [],
        }),
      ).rejects.toThrow();
    }
    expect(fixture.goal.status).toBe("running");
    expect(fixture.tx.goalRevision.create).not.toHaveBeenCalled();
    expect(fixture.tx.teamGoal.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.event.create).not.toHaveBeenCalled();
  });
  it("queues one board comment with the result and does not close on submit", async () => {
    const fixture = reviewFixture();
    fixture.goal.boardWorkspaceId = "workspace";
    fixture.goal.boardItemId = "board-a";
    const revision = await fixture.submit();
    expect(fixture.tx.goalBoardDelivery.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.goalBoardDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        transition: "completed",
        workspaceId: "workspace",
        itemId: "board-a",
        state: "pending",
        revisionId: revision.id,
      }),
    });
    const payload = fixture.tx.goalBoardDelivery.create.mock.calls[0]?.[0].data
      .commentText as string;
    expect(payload).toContain("Goal completed");
    expect(payload).toContain(revision.id);
    expect(payload).not.toContain("Goal accepted");
  });
  it.each(["accept", "reject"] as const)(
    "refuses %s by a non-owner or an owner outside the goal scope",
    async (operation) => {
      const fixture = reviewFixture();
      const revision = await fixture.submit();
      const input = {
        goalId: fixture.goal.id,
        revisionId: revision.id,
        reworkNotes: "Review again",
      };
      for (const actor of [
        { ...owner, isDeploymentOwner: false },
        { ...owner, userId: "other-user" },
        { ...owner, spaceId: "other-space" },
      ]) {
        await expect(
          (operation === "accept" ? acceptGoal : rejectGoal)(fixture.prisma, actor, input),
        ).rejects.toThrow();
      }
      expect(fixture.tx.goalVerdict.create).not.toHaveBeenCalled();
    },
  );

  it("projects submission JSON and timestamps through the same contract used by goal reads", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    expect(revision.createdAt).toBe(now.toISOString());
    expect(revision.conditions).toEqual([
      {
        id: "cond-final",
        description: GOAL_FINAL_REVIEW_DESCRIPTION,
        status: "unknown",
        actorId: null,
        reason: null,
        evidenceId: null,
        createdAt: null,
      },
    ]);
    expect((await getGoal(fixture.prisma, owner, fixture.goal.groupId))?.currentRevision).toEqual(
      revision,
    );
    expect(fixture.tx.teamGoal.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        include: { revisions: { orderBy: { attempts: "desc" }, take: 1 } },
      }),
    );
  });

  it("keeps the reviewed submission unchanged and creates a new revision for rework", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    const snapshot = structuredClone(fixture.revisions[0]);
    await expect(fixture.submit()).rejects.toThrow("already submitted");
    const input = { goalId: fixture.goal.id, revisionId: revision.id, reworkNotes: "Review again" };
    const rejected = await rejectGoal(fixture.prisma, owner, input);
    expect(await rejectGoal(fixture.prisma, owner, input)).toEqual(rejected);
    await expect(acceptGoal(fixture.prisma, owner, input)).rejects.toThrow("already reviewed");
    const next = await fixture.submit();
    expect(next.attempts).toBe(2);
    expect(next.id).not.toBe(revision.id);
    expect(fixture.revisions[0]).toEqual(snapshot);
    await expect(acceptGoal(fixture.prisma, owner, input)).rejects.toThrow("not current");
    await expect(rejectGoal(fixture.prisma, owner, input)).rejects.toThrow("not current");
  });

  it("returns the same acceptance on retry and cannot reject or overwrite it", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    const input = { goalId: fixture.goal.id, revisionId: revision.id };
    await reviewGoalCondition(fixture.prisma, owner, {
      goalId: fixture.goal.id,
      revisionId: revision.id,
      conditionId: "cond-final",
      status: "pass",
    });
    const snapshot = structuredClone(fixture.revisions[0]);
    const accepted = await acceptGoal(fixture.prisma, owner, input);
    expect(await acceptGoal(fixture.prisma, owner, input)).toEqual(accepted);
    expect(accepted.createdAt).toBe(now.toISOString());
    expect(fixture.tx.goalVerdict.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.event.create).toHaveBeenCalledTimes(2);
    await expect(
      rejectGoal(fixture.prisma, owner, { ...input, reworkNotes: "Reopen" }),
    ).rejects.toThrow("already reviewed");
    await expect(fixture.submit()).rejects.toThrow("already submitted");
    expect(fixture.goal.status).toBe("accepted");
    expect(fixture.revisions[0]).toEqual(snapshot);
  });

  it.each(["accept", "reject"] as const)(
    "locks thread then root before %s reads the current state",
    async (operation) => {
      const fixture = reviewFixture();
      const revision = await fixture.submit();
      if (operation === "accept") {
        await reviewGoalCondition(fixture.prisma, owner, {
          goalId: fixture.goal.id,
          revisionId: revision.id,
          conditionId: "cond-final",
          status: "pass",
        });
      }
      fixture.tx.$queryRaw.mockClear();
      fixture.tx.teamGoal.findUniqueOrThrow.mockClear();
      const input = {
        goalId: fixture.goal.id,
        revisionId: revision.id,
        reworkNotes: "Review again",
      };
      await (operation === "accept" ? acceptGoal : rejectGoal)(fixture.prisma, owner, input);
      expect(fixture.tx.$queryRaw).toHaveBeenNthCalledWith(
        1,
        ["SELECT id FROM threads WHERE id = ", " FOR UPDATE"],
        fixture.goal.threadId,
      );
      expect(fixture.tx.$queryRaw).toHaveBeenNthCalledWith(
        2,
        ["SELECT id FROM tasks WHERE id = ", " FOR UPDATE"],
        fixture.goal.rootTaskId,
      );
      expect(fixture.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        fixture.tx.teamGoal.findUniqueOrThrow.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("refuses acceptance while reservations remain unsettled", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    fixture.root.reservedTokens = 10;
    await expect(
      acceptGoal(fixture.prisma, owner, { goalId: fixture.goal.id, revisionId: revision.id }),
    ).rejects.toThrow("Unsettled reservations");
    expect(fixture.tx.goalVerdict.create).not.toHaveBeenCalled();
    expect(fixture.goal.status).toBe("completed");
  });

  it("submits the coordinator report as the revision under review", async () => {
    const fixture = reviewFixture();
    const revision = await submitGoalFromCoordinator(fixture.prisma, {
      goalId: fixture.goal.id,
      spaceId: owner.spaceId,
      userId: owner.userId,
      coordinatorBotId: fixture.goal.coordinatorBotId,
      threadId: fixture.goal.threadId,
      summary: "The reviewed wording is ready.",
    });
    expect(revision.summary).toBe("The reviewed wording is ready.");
    expect(fixture.goal.status).toBe("completed");
    expect(fixture.tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "goal.submitted" }),
    });
    await expect(
      submitGoalFromCoordinator(fixture.prisma, {
        goalId: fixture.goal.id,
        spaceId: owner.spaceId,
        userId: owner.userId,
        coordinatorBotId: "other-bot",
        threadId: fixture.goal.threadId,
        summary: "Not the coordinator",
      }),
    ).rejects.toThrow();
    expect(fixture.tx.goalRevision.create).toHaveBeenCalledTimes(1);
  });

  it("wakes the coordinator once with the rework notes", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    const input = {
      goalId: fixture.goal.id,
      revisionId: revision.id,
      reworkNotes: "Review again",
    };
    await rejectGoal(fixture.prisma, owner, input);
    await rejectGoal(fixture.prisma, owner, input);
    expect(fixture.tx.run.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prompt: expect.stringContaining("Review again"),
        botId: fixture.goal.coordinatorBotId,
      }),
    });
    expect(fixture.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientNonce: `goal-rework:${revision.id}`,
        goalId: fixture.goal.id,
      }),
    });
    expect(fixture.goal.status).toBe("running");
  });

  it("refuses acceptance until every condition passes and stays idempotent after", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    const input = { goalId: fixture.goal.id, revisionId: revision.id };
    await expect(acceptGoal(fixture.prisma, owner, input)).rejects.toThrow(
      "Every condition must pass",
    );
    expect(fixture.tx.goalVerdict.create).not.toHaveBeenCalled();
    await reviewGoalCondition(fixture.prisma, owner, {
      ...input,
      conditionId: "cond-final",
      status: "fail",
    });
    await expect(acceptGoal(fixture.prisma, owner, input)).rejects.toThrow(
      "Every condition must pass",
    );
    await reviewGoalCondition(fixture.prisma, owner, {
      ...input,
      conditionId: "cond-final",
      status: "pass",
    });
    const accepted = await acceptGoal(fixture.prisma, owner, input);
    expect(await acceptGoal(fixture.prisma, owner, input)).toEqual(accepted);
    expect(fixture.tx.goalVerdict.create).toHaveBeenCalledTimes(1);
  });

  it("cancels queued runs when the submission freezes the goal and reports them", async () => {
    const fixture = reviewFixture();
    fixture.tx.run.findMany.mockResolvedValue([
      { id: "run-queued", taskId: "task-queued", delegationId: null },
    ]);
    fixture.tx.run.updateMany.mockResolvedValue({ count: 1 });
    const revision = await fixture.submit();
    expect(fixture.tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-queued", status: "queued" },
      data: expect.objectContaining({ status: "cancelled" }),
    });
    expect(fixture.tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-queued"] } },
      data: { status: "cancelled" },
    });
    expect(fixture.tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "goal.submitted",
        payload: { goalId: fixture.goal.id, revisionId: revision.id, frozenRunIds: ["run-queued"] },
      }),
    });
  });

  it("keeps a queued run that a concurrent claim leased before the freeze", async () => {
    const fixture = reviewFixture();
    fixture.tx.run.findMany.mockResolvedValue([
      { id: "run-claimed", taskId: "task-claimed", delegationId: null },
    ]);
    // The claim won the row first: the conditional cancellation matches nothing and
    // the in-flight run may finish its call.
    fixture.tx.run.updateMany.mockResolvedValue({ count: 0 });
    await fixture.submit();
    expect(fixture.tx.task.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: { goalId: fixture.goal.id, revisionId: expect.any(String) },
      }),
    });
  });

  it.each(["approved", "executing"])(
    "refuses submission while a %s replay is pending or in flight",
    async (status) => {
      const f = reviewFixture();
      f.tx.externalEffect.findFirst.mockImplementation(
        async ({ where }: { where: { status: unknown } }) =>
          where.status === "executing" && status === "approved" ? null : { id: "replay", status },
      );
      await expect(f.submit()).rejects.toMatchObject({ reason: "effects-open" });
      expect(f.goal.status).toBe("running");
      expect(f.revisions).toHaveLength(0);
      expect(f.tx.goalBoardDelivery.create).not.toHaveBeenCalled();
      expect(f.tx.externalEffect.findFirst).toHaveBeenCalledWith({
        where: {
          spaceId: f.goal.spaceId,
          run: { is: { OR: [{ goalId: f.goal.id }, { delegationRootTaskId: f.goal.rootTaskId }] } },
          status:
            status === "executing" ? "executing" : { in: ["intended", "approved", "executing"] },
        },
        select: { id: true },
      });
      f.tx.externalEffect.findFirst.mockResolvedValue(null);
      await expect(f.submit()).resolves.toMatchObject({ id: "revision-1" });
    },
  );

  it.each(["attempt", "request"])(
    "refuses acceptance until the final %s collection cut",
    async (kind) => {
      const f = reviewFixture();
      const revision = await f.submit();
      const input = { goalId: f.goal.id, revisionId: revision.id };
      await reviewGoalCondition(f.prisma, owner, {
        ...input,
        conditionId: "cond-final",
        status: "pass",
      });
      if (kind === "attempt")
        f.tx.attempt.findFirst.mockResolvedValue({ id: "terminal-but-collecting" });
      else
        f.tx.usageRecord.findFirst.mockResolvedValue({ id: "unreported-but-collecting" } as never);
      await expect(acceptGoal(f.prisma, owner, input)).rejects.toMatchObject({
        reason: "work-active",
      });
      expect(f.tx.goalVerdict.create).not.toHaveBeenCalled();
      expect(f.tx.goalSettlement.create).not.toHaveBeenCalled();
      expect(f.goal.status).toBe("completed");
      expect(f.tx.attempt.findFirst).toHaveBeenCalledWith({
        where: {
          run: {
            is: {
              spaceId: f.goal.spaceId,
              userId: f.goal.userId,
              OR: [{ goalId: f.goal.id }, { delegationRootTaskId: f.goal.rootTaskId }],
            },
          },
          usageSettledAt: null,
        },
        select: { id: true },
      });
      f.tx.attempt.findFirst.mockResolvedValue(null);
      f.tx.usageRecord.findFirst.mockResolvedValue(null);
      await expect(acceptGoal(f.prisma, owner, input)).resolves.toMatchObject({ type: "accept" });
    },
  );

  it("refuses acceptance while an execution lease is live", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    await reviewGoalCondition(fixture.prisma, owner, {
      goalId: fixture.goal.id,
      revisionId: revision.id,
      conditionId: "cond-final",
      status: "pass",
    });
    fixture.tx.run.findFirst.mockResolvedValue({ id: "run-live" });
    await expect(
      acceptGoal(fixture.prisma, owner, { goalId: fixture.goal.id, revisionId: revision.id }),
    ).rejects.toThrow("A live execution");
    expect(fixture.tx.goalVerdict.create).not.toHaveBeenCalled();
    expect(fixture.tx.goalSettlement.create).not.toHaveBeenCalled();
    expect(fixture.goal.status).toBe("completed");
  });

  it.each(["queued", "leased", "running"])(
    "refuses acceptance for %s work even without a live lease",
    async (status) => {
      const f = reviewFixture();
      const revision = await f.submit();
      await reviewGoalCondition(f.prisma, owner, {
        goalId: f.goal.id,
        revisionId: revision.id,
        conditionId: "cond-final",
        status: "pass",
      });
      f.tx.run.findFirst.mockImplementation(async (...args: unknown[]) => {
        const where = (args[0] as { where: { status?: { in: string[] } } }).where;
        return where.status?.in.includes(status) ? { id: "unsettled-run" } : null;
      });
      await expect(
        acceptGoal(f.prisma, owner, { goalId: f.goal.id, revisionId: revision.id }),
      ).rejects.toMatchObject({ reason: "lease-active" });
      expect(f.tx.goalSettlement.create).not.toHaveBeenCalled();
    },
  );

  it("refuses acceptance while an effect is unsettled", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    await reviewGoalCondition(fixture.prisma, owner, {
      goalId: fixture.goal.id,
      revisionId: revision.id,
      conditionId: "cond-final",
      status: "pass",
    });
    fixture.tx.externalEffect.findFirst.mockResolvedValue({ id: "effect-1" });
    await expect(
      acceptGoal(fixture.prisma, owner, { goalId: fixture.goal.id, revisionId: revision.id }),
    ).rejects.toThrow("Unsettled effects");
    expect(fixture.tx.goalVerdict.create).not.toHaveBeenCalled();
    expect(fixture.goal.status).toBe("completed");
  });

  it("writes one settlement marker at acceptance and projects it on the goal", async () => {
    const fixture = reviewFixture();
    const revision = await fixture.submit();
    const input = { goalId: fixture.goal.id, revisionId: revision.id };
    await reviewGoalCondition(fixture.prisma, owner, {
      ...input,
      conditionId: "cond-final",
      status: "pass",
    });
    await acceptGoal(fixture.prisma, owner, input);
    expect(fixture.tx.goalSettlement.create).toHaveBeenCalledTimes(1);
    expect(fixture.tx.goalSettlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        goalId: fixture.goal.id,
        revisionId: revision.id,
        rootTaskId: fixture.goal.rootTaskId,
        usedTokens: fixture.root.usedTokens,
      }),
    });
    fixture.tx.goalSettlement.findUnique.mockResolvedValue({
      goalId: fixture.goal.id,
      revisionId: revision.id,
      usedTokens: fixture.root.usedTokens,
      reservedTokens: 0,
      createdAt: now,
    });
    fixture.tx.goalSettlementDiscrepancy.aggregate.mockResolvedValue({
      _sum: { tokens: 15 },
      _count: 1,
    });
    const loaded = await getGoal(fixture.prisma, owner, fixture.goal.groupId);
    expect(loaded?.settlement).toEqual({
      revisionId: revision.id,
      usedTokens: fixture.root.usedTokens,
      reservedTokens: 0,
      lateTokens: 15,
      discrepancyCount: 1,
      createdAt: now.toISOString(),
    });
  });

  it("admits run effects only while the goal is unfrozen, under the root lock", async () => {
    let goalStatus = "running";
    const tx = {
      $queryRaw: vi.fn(async () => []),
      teamGoal: {
        findFirst: vi.fn(async () => ({ status: goalStatus })),
      },
      externalEffect: {
        create: vi.fn(async ({ data }: { data: { idempotencyKey: string } }) => ({
          ...data,
          id: `effect-${data.idempotencyKey}`,
        })),
      },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    const input = {
      spaceId: owner.spaceId,
      userId: owner.userId,
      goalId: "goal-1",
      rootTaskId: "root-1",
      runId: "run-1",
      kind: "fixture_effect",
      idempotencyKey: "effect-key",
      request: { value: 1 },
    };
    const admitted = await admitGoalRunEffect(prisma, input);
    expect(admitted.ok).toBe(true);
    expect(tx.externalEffect.create).toHaveBeenCalledTimes(1);
    // The root lock is taken before the goal state is read, so the freeze and the
    // acceptance check serialize with this admission.
    expect(tx.$queryRaw).toHaveBeenCalledBefore(tx.teamGoal.findFirst as never);

    goalStatus = "completed";
    await expect(
      admitGoalRunEffect(prisma, { ...input, idempotencyKey: "effect-key-2" }),
    ).resolves.toEqual({
      ok: false,
      reason: "goal-frozen",
    });
    expect(tx.externalEffect.create).toHaveBeenCalledTimes(1);
  });

  it("resumes after send-back with a fresh run while frozen queued runs stay cancelled", async () => {
    const fixture = reviewFixture();
    fixture.tx.run.findMany.mockResolvedValue([
      { id: "run-queued", taskId: "task-queued", delegationId: null },
    ]);
    fixture.tx.run.updateMany.mockResolvedValue({ count: 1 });
    const revision = await fixture.submit();
    await rejectGoal(fixture.prisma, owner, {
      goalId: fixture.goal.id,
      revisionId: revision.id,
      reworkNotes: "Review again",
    });
    expect(fixture.goal.status).toBe("running");
    expect(fixture.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientNonce: `goal-rework:${revision.id}`,
        goalId: fixture.goal.id,
        status: "queued",
      }),
    });
    // The frozen run was cancelled at submission (conditional check plus the shared
    // cancellation helper); rework queues a new run instead of reviving it.
    expect(fixture.tx.run.updateMany).toHaveBeenCalledTimes(2);
  });

  it("denies the effects of queued runs the submission freeze cancelled", async () => {
    const fixture = reviewFixture();
    fixture.tx.run.findMany.mockResolvedValue([
      { id: "run-queued", taskId: "task-queued", delegationId: null },
    ]);
    fixture.tx.run.updateMany.mockResolvedValue({ count: 1 });
    await fixture.submit();
    // An approval answered just before submission approved the effect and queued the
    // run; the freeze cancels the run, so the prevented dispatch must settle too —
    // otherwise acceptance refuses the goal with unsettled effects forever.
    expect(fixture.tx.externalEffect.updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: fixture.goal.spaceId,
        runId: { in: ["run-queued"] },
        status: { in: ["intended", "approved", "paused"] },
      },
      data: { status: "denied" },
    });
  });
});

describe("goal freeze at resume and replay", () => {
  function frozenRunFixture(runStatus: string, goalStatus: string) {
    const state = {
      run: {
        id: "run-held",
        spaceId: owner.spaceId,
        userId: owner.userId,
        taskId: "task-held",
        delegationId: null as string | null,
        goalId: "goal-1" as string | null,
        delegationRootTaskId: "task-root" as string | null,
        status: runStatus,
        leaseExpiresAt:
          runStatus === "running" ? new Date(Date.now() + 60_000) : (null as Date | null),
      },
      goalStatus,
    };
    const effectUpdates: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      teamGoal: {
        findFirst: vi.fn(async () => ({
          status: state.goalStatus,
          rootTaskId: "task-root",
          spaceId: owner.spaceId,
          userId: owner.userId,
        })),
      },
      run: {
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: {
              status?: string;
              OR?: [
                { status: { in: string[] } },
                { status: { in: string[] }; leaseExpiresAt: { lte: Date } },
              ];
            };
            data: Record<string, unknown>;
          }) => {
            // The claim-compatible guard: only a run the continue claim could lease is
            // cancelled; a live in-flight lease survives.
            if (where.OR) {
              const claimable =
                where.OR[0].status.in.includes(state.run.status) ||
                (["leased", "running"].includes(state.run.status) &&
                  state.run.leaseExpiresAt !== null &&
                  state.run.leaseExpiresAt <= where.OR[1].leaseExpiresAt.lte);
              if (!claimable) return { count: 0 };
            }
            if (where.status && state.run.status !== where.status) return { count: 0 };
            Object.assign(state.run, data);
            return { count: 1 };
          },
        ),
      },
      delegation: { findFirst: vi.fn(async () => null) },
      externalEffect: {
        updateMany: vi.fn(async (args: unknown) => {
          effectUpdates.push(args);
          return { count: 1 };
        }),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      ...tx,
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    return { prisma, tx, state, effectUpdates };
  }

  it.each(["queued", "waiting_input", "waiting_takeover", "peer_paused", "peer_ready"] as const)(
    "cancels and settles a %s run a stale continue claims while the goal is frozen",
    async (status) => {
      const f = frozenRunFixture(status, "completed");
      const held = await cancelRunHeldByFrozenGoal(f.prisma, f.state.run);
      expect(held).toBe(true);
      expect(f.state.run.status).toBe("cancelled");
      // The prevented dispatch is denied, and an effect that may already have run is
      // kept uncertain for the owner.
      expect(f.effectUpdates).toEqual([
        expect.objectContaining({
          where: expect.objectContaining({
            runId: { in: ["run-held"] },
            status: { in: ["intended", "approved", "paused"] },
          }),
          data: { status: "denied" },
        }),
        expect.objectContaining({
          where: expect.objectContaining({
            runId: { in: ["run-held"] },
            status: "executing",
          }),
          data: { status: "uncertain" },
        }),
      ]);
    },
  );

  it("settles a run holding an expired lease but leaves a live in-flight lease alone", async () => {
    const expired = frozenRunFixture("running", "completed");
    expired.state.run.leaseExpiresAt = new Date(Date.now() - 60_000);
    await expect(cancelRunHeldByFrozenGoal(expired.prisma, expired.state.run)).resolves.toBe(true);
    expect(expired.state.run.status).toBe("cancelled");

    const inFlight = frozenRunFixture("running", "completed");
    await expect(cancelRunHeldByFrozenGoal(inFlight.prisma, inFlight.state.run)).resolves.toBe(
      false,
    );
    // The conditional cancellation matched nothing: the live lease survives untouched.
    expect(inFlight.state.run.status).toBe("running");
    expect(inFlight.effectUpdates).toEqual([]);
  });

  it("rereads the freeze under the review lock when rework reopens after its initial read", async () => {
    const f = frozenRunFixture("queued", "completed");
    f.tx.$queryRaw.mockImplementation(async () => {
      f.state.goalStatus = "running";
      return [];
    });
    await expect(cancelRunHeldByFrozenGoal(f.prisma, f.state.run)).resolves.toBe(false);
    expect(f.state.run.status).toBe("queued");
    expect(f.effectUpdates).toEqual([]);
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
  });

  it.each(["approved", "intended"] as const)(
    "claims a %s effect only under the root lock and current goal state",
    async (from) => {
      const f = frozenRunFixture("running", "running");
      const input = {
        spaceId: owner.spaceId,
        userId: owner.userId,
        goalId: "goal-1",
        rootTaskId: "task-root",
        effectId: "effect-1",
        from,
      };
      // Freeze wins between the lookup and claim, even if an earlier check admitted replay.
      f.tx.$queryRaw.mockImplementation(async () => {
        f.state.goalStatus = "completed";
        return [];
      });
      await expect(claimGoalRunEffect(f.prisma, input)).resolves.toBe(false);
      expect(f.tx.externalEffect.updateMany).not.toHaveBeenCalled();
      f.state.goalStatus = "running";
      f.tx.$queryRaw.mockImplementation(async () => []);
      await expect(claimGoalRunEffect(f.prisma, input)).resolves.toBe(true);
      expect(f.effectUpdates).toEqual([
        {
          where: { id: "effect-1", spaceId: owner.spaceId, status: from },
          data: { status: "executing" },
        },
      ]);
    },
  );

  it("keeps ordinary delegated effect claims working without a goal", async () => {
    const f = frozenRunFixture("running", "running");
    f.tx.teamGoal.findFirst.mockResolvedValue(null as never);
    await expect(
      claimGoalRunEffect(f.prisma, {
        spaceId: owner.spaceId,
        userId: owner.userId,
        goalId: null,
        rootTaskId: "ordinary-root",
        effectId: "effect-1",
        from: "approved",
      }),
    ).resolves.toBe(true);
    expect(f.effectUpdates).toHaveLength(1);
  });

  it("does not hold a run while the goal is running or after send-back unfreezes it", async () => {
    const running = frozenRunFixture("queued", "running");
    await expect(cancelRunHeldByFrozenGoal(running.prisma, running.state.run)).resolves.toBe(false);
    expect(running.tx.run.updateMany).not.toHaveBeenCalled();

    const notGoalRun = frozenRunFixture("queued", "completed");
    notGoalRun.state.run.goalId = null;
    notGoalRun.state.run.delegationRootTaskId = null;
    await expect(cancelRunHeldByFrozenGoal(notGoalRun.prisma, notGoalRun.state.run)).resolves.toBe(
      false,
    );
    expect(notGoalRun.tx.teamGoal.findFirst).not.toHaveBeenCalled();
  });

  it("holds a replayed effect while frozen, under the root lock, and admits it while running", async () => {
    let goalStatus = "completed";
    const tx = {
      $queryRaw: vi.fn(async () => []),
      teamGoal: {
        findFirst: vi.fn(async () => ({ rootTaskId: "task-root", status: goalStatus })),
      },
    };
    const prisma = {
      ...tx,
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    const input = { spaceId: owner.spaceId, userId: owner.userId, goalId: "goal-1" };
    // Early refusal reads under the root lock. Dispatch also claims under that lock.
    await expect(isGoalRunEffectFrozen(prisma, input)).resolves.toBe(true);
    // The status lookup happens after locking, rather than using the earlier read.
    const reads = tx.teamGoal.findFirst.mock.invocationCallOrder;
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeGreaterThan(reads[0]!);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(reads[reads.length - 1]!);

    goalStatus = "running";
    await expect(isGoalRunEffectFrozen(prisma, input)).resolves.toBe(false);
  });
});
