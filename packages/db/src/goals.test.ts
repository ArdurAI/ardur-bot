import type { Actor } from "@ardurbot/contracts";
import { GOAL_FINAL_REVIEW_DESCRIPTION } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  acceptGoal,
  getGoal,
  goalExhaustionReason,
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
      run: { create: runCreate, findFirst: vi.fn(async () => null) },
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
    delegation: { findMany: vi.fn(async () => []) },
    chatGroup: { findFirst: vi.fn(async () => ({ id: goal.groupId })) },
    task: { create: vi.fn(async () => ({ id: "task-rework" })) },
    usageRecord: { findFirst: vi.fn(async () => null) },
    run: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "run-rework" })),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
  };
  const prisma = {
    teamGoal: tx.teamGoal,
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
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
});
