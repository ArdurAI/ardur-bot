import type { Actor } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { Prisma as PrismaNS } from "./client.js";
import {
  GoalPlanConflict,
  listReadyGoalPlanSteps,
  markGoalPlanStepDispatched,
  planHasCycle,
  recordGoalPlanStepOutcome,
  settleGoalPlanStep,
  updateGoalPlan,
} from "./goal-plan.js";

const owner: Actor = {
  spaceId: "space-1",
  userId: "owner-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

const goal = {
  id: "goal-1",
  spaceId: owner.spaceId,
  userId: owner.userId,
  groupId: "group-1",
  threadId: "thread-1",
  coordinatorBotId: "bot-chief",
  rootTaskId: "task-root",
  objective: "Ship the report",
  doneWhen: ["Report accepted"],
  status: "running",
  planRevision: 3,
  untilAt: new Date("2030-01-02T00:00:00.000Z"),
  createdAt: new Date("2030-01-01T00:00:00.000Z"),
};

const memberBot = { botId: "bot-writer" };

type StepRow = {
  id: string;
  goalId: string;
  clientId: string;
  revision: number;
  position: number;
  title: string;
  ownerId: string;
  ownerIsUser: boolean;
  condition: string;
  status: string;
  prerequisiteIds: string[];
  outcome: unknown;
  dispatchRunId: string | null;
  dispatch: unknown;
  updatedAt: Date;
};

function stepRow(overrides: Partial<StepRow> & { clientId: string }): StepRow {
  return {
    id: `row-${overrides.clientId}`,
    goalId: goal.id,
    revision: goal.planRevision,
    position: 0,
    title: `Step ${overrides.clientId}`,
    ownerId: memberBot.botId,
    ownerIsUser: false,
    condition: "Records support it",
    status: "pending",
    prerequisiteIds: [],
    outcome: null,
    dispatchRunId: null,
    dispatch: null,
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** A tx double that runs commitPlanUpdate against an in-memory step list. */
function planFixture(options: {
  steps?: StepRow[];
  goalOverrides?: Record<string, unknown>;
  members?: { botId: string }[];
  /** A live group so owner actions queue the coordinator wake. */
  wakeGroup?: boolean;
}) {
  const steps = options.steps ?? [];
  const currentGoal = {
    ...goal,
    tokenLimit: 600_000,
    perWorkerTokens: 30_000,
    maxConcurrent: 2,
    maxDescendants: 60,
    stoppedAt: null,
    boardWorkspaceId: null,
    boardItemId: null,
    ...(options.goalOverrides ?? {}),
  };
  const state = { supportRun: null as Record<string, unknown> | null };
  const loadableGoal = { ...currentGoal, revisions: [] };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    teamGoal: {
      findFirst: vi.fn(async () => loadableGoal),
      findUnique: vi.fn(async () => currentGoal),
      findUniqueOrThrow: vi.fn(async () => currentGoal),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(args.data)) {
          (currentGoal as Record<string, unknown>)[key] = value === PrismaNS.DbNull ? null : value;
        }
        return currentGoal;
      }),
      updateMany: vi.fn(async () => {
        currentGoal.planRevision += 1;
        return { count: 1 };
      }),
    },
    goalPlanStep: {
      findMany: vi.fn(
        async (args?: {
          where?: { goalId?: string };
          orderBy?: Record<string, string> | ReadonlyArray<Record<string, string>> | undefined;
        }) => {
          let rows = args?.where?.goalId
            ? steps.filter((row) => row.goalId === args.where?.goalId)
            : [...steps];
          const clauses = args?.orderBy
            ? Array.isArray(args.orderBy)
              ? args.orderBy
              : [args.orderBy]
            : [];
          for (const clause of [...clauses].reverse()) {
            const entries = Object.entries(clause);
            rows = [...rows].sort((a, b) => {
              for (const [key, dir] of entries) {
                const av = String((a as Record<string, unknown>)[key] ?? "");
                const bv = String((b as Record<string, unknown>)[key] ?? "");
                const cmp = av.localeCompare(bv);
                if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
              }
              return 0;
            });
          }
          return rows;
        },
      ),
      findFirst: vi.fn(async (args: { where: { id?: string; clientId?: string } }) =>
        steps.find((row) => row.id === args.where.id || row.clientId === args.where.clientId),
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> & { clientId: string } }) => {
        const row = stepRow({ ...args.data, clientId: args.data.clientId } as Partial<StepRow> & {
          clientId: string;
        });
        steps.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = steps.find((entry) => entry.id === args.where.id);
        if (!row) throw new Error("missing step row");
        for (const [key, value] of Object.entries(args.data)) {
          (row as unknown as Record<string, unknown>)[key] =
            value === PrismaNS.DbNull ? null : value;
        }
        return row;
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = steps.find((entry) => entry.id === args.where.id);
          if (!row || row.dispatchRunId !== null) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      ),
    },
    chatGroupMember: {
      findMany: vi.fn(async () => options.members ?? [memberBot, { botId: "bot-chief" }]),
    },
    chatGroup: {
      findFirst: vi.fn(async () => (options.wakeGroup ? { id: goal.groupId } : null)),
    },
    run: {
      findFirst: vi.fn(async () => state.supportRun),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: "wake-run",
        ...args.data,
      })),
    },
    task: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: "wake-task",
        ...args.data,
      })),
    },
    delegationRoot: { findFirst: vi.fn(async () => null) },
    usageRecord: { findFirst: vi.fn(async () => null) },
    goalBoardDelivery: { findMany: vi.fn(async () => []) },
    goalSettlement: { findUnique: vi.fn(async () => null) },
    goalSettlementDiscrepancy: { aggregate: vi.fn(async () => ({ _sum: {}, _count: 0 })) },
  };
  const prisma = {
    ...tx,
    teamGoal: {
      ...tx.teamGoal,
      findFirst: vi.fn(async () => currentGoal),
    },
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return {
    tx,
    prisma: prisma as unknown as PrismaClient,
    steps,
    currentGoal,
    state,
  };
}

function stepInput(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: clientId,
    title: `Step ${clientId}`,
    ownerId: memberBot.botId,
    ownerIsUser: false,
    condition: "Records support it",
    prerequisiteIds: [],
    ...overrides,
  };
}

describe("plan dependency validation", () => {
  it("rejects a dependency cycle", () => {
    expect(
      planHasCycle([
        stepInput("a", { prerequisiteIds: ["b"] }),
        stepInput("b", { prerequisiteIds: ["a"] }),
      ]),
    ).toBe(true);
    expect(planHasCycle([stepInput("a", { prerequisiteIds: ["a"] })])).toBe(true);
    expect(
      planHasCycle([
        stepInput("a", { prerequisiteIds: ["b", "c"] }),
        stepInput("b"),
        stepInput("c", { prerequisiteIds: ["b"] }),
      ]),
    ).toBe(false);
  });

  it("refuses a plan whose prerequisite is not a step in the plan", async () => {
    const fixture = planFixture({});
    await expect(
      updateGoalPlan(
        fixture.prisma,
        { actor: owner },
        {
          goalId: goal.id,
          baseRevision: 3,
          steps: [stepInput("a", { prerequisiteIds: ["ghost"] })],
        },
      ),
    ).rejects.toMatchObject({ reason: "prerequisite-missing" });
  });

  it("refuses owners that are not the person or a group member", async () => {
    const fixture = planFixture({});
    await expect(
      updateGoalPlan(
        fixture.prisma,
        { actor: owner },
        { goalId: goal.id, baseRevision: 3, steps: [stepInput("a", { ownerId: "bot-stranger" })] },
      ),
    ).rejects.toMatchObject({ reason: "unknown-owner" });
    await expect(
      updateGoalPlan(
        fixture.prisma,
        { actor: owner },
        {
          goalId: goal.id,
          baseRevision: 3,
          steps: [stepInput("a", { ownerId: "someone-else", ownerIsUser: true })],
        },
      ),
    ).rejects.toMatchObject({ reason: "unknown-owner" });
  });

  it("refuses a stale base revision", async () => {
    const fixture = planFixture({});
    await expect(
      updateGoalPlan(
        fixture.prisma,
        { actor: owner },
        { goalId: goal.id, baseRevision: 2, steps: [stepInput("a")] },
      ),
    ).rejects.toMatchObject({ reason: "revision-changed" });
  });

  it("refuses changes to a goal that is not running", async () => {
    const fixture = planFixture({ goalOverrides: { status: "completed" } });
    await expect(
      updateGoalPlan(
        fixture.prisma,
        { actor: owner },
        { goalId: goal.id, baseRevision: 3, steps: [stepInput("a")] },
      ),
    ).rejects.toMatchObject({ reason: "not-running" });
  });
});

describe("plan update application", () => {
  it("cancels a listed-then-omitted step instead of deleting it and bumps the revision", async () => {
    const kept = stepRow({ clientId: "kept" });
    const dropped = stepRow({ clientId: "dropped", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [kept, dropped] });
    const saved = await updateGoalPlan(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, baseRevision: 3, steps: [stepInput("kept")] },
    );
    const cancelled = fixture.steps.find((row) => row.clientId === "dropped");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.revision).toBe(4);
    expect(fixture.steps.find((row) => row.clientId === "kept")?.revision).toBe(4);
    expect(saved.id).toBe(goal.id);
    expect(fixture.currentGoal.planRevision).toBe(4);
  });

  it("marks a pending step blocked when a prerequisite is cancelled", async () => {
    const priorCancelled = stepRow({ clientId: "base", status: "cancelled" });
    const waiting = stepRow({ clientId: "next", prerequisiteIds: ["base"] });
    const fixture = planFixture({ steps: [priorCancelled, waiting] });
    await updateGoalPlan(
      fixture.prisma,
      { actor: owner },
      {
        goalId: goal.id,
        baseRevision: 3,
        steps: [stepInput("base"), stepInput("next", { prerequisiteIds: ["base"] })],
      },
    );
    expect(fixture.steps.find((row) => row.clientId === "base")?.status).toBe("cancelled");
    expect(fixture.steps.find((row) => row.clientId === "next")?.status).toBe("blocked");
  });

  it("stores the submitted order and reads steps back in it", async () => {
    const a = stepRow({ clientId: "a" });
    const b = stepRow({ clientId: "b" });
    const fixture = planFixture({ steps: [a, b] });
    await updateGoalPlan(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, baseRevision: 3, steps: [stepInput("a"), stepInput("b")] },
    );
    const swapped = await updateGoalPlan(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, baseRevision: 4, steps: [stepInput("b"), stepInput("a")] },
    );
    expect(fixture.steps.find((row) => row.clientId === "a")?.position).toBe(1);
    expect(fixture.steps.find((row) => row.clientId === "b")?.position).toBe(0);
    expect(swapped.plan?.steps.map((step) => step.id)).toEqual(["b", "a"]);
  });

  it("keeps a recorded outcome on a carried done step", async () => {
    const done = stepRow({
      clientId: "done-step",
      status: "done",
      outcome: { actorId: owner.userId, support: [], recordedAt: new Date().toISOString() },
    });
    const fixture = planFixture({ steps: [done] });
    await updateGoalPlan(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, baseRevision: 3, steps: [stepInput("done-step")] },
    );
    expect(fixture.steps[0]?.status).toBe("done");
    expect(fixture.steps[0]?.outcome).toMatchObject({ actorId: owner.userId });
  });
});

describe("ready computation and exactly-once dispatch", () => {
  it("lists only pending bot-owned steps whose prerequisites are done", async () => {
    const ready = stepRow({ clientId: "ready" });
    const waiting = stepRow({ clientId: "waiting", prerequisiteIds: ["ready"] });
    const userOwned = stepRow({ clientId: "mine", ownerId: owner.userId, ownerIsUser: true });
    const chiefOwned = stepRow({ clientId: "chief", ownerId: "bot-chief" });
    const blocked = stepRow({ clientId: "stuck", status: "blocked" });
    const dispatched = stepRow({ clientId: "out", status: "active", dispatchRunId: "run-9" });
    const fixture = planFixture({
      steps: [ready, waiting, userOwned, chiefOwned, blocked, dispatched],
    });
    const listed = await listReadyGoalPlanSteps(
      fixture.prisma as unknown as Prisma.TransactionClient,
      goal.id,
    );
    expect(listed.map((row) => row.clientId)).toEqual(["ready"]);
  });

  it("returns no ready steps for a goal that is not running", async () => {
    const fixture = planFixture({
      steps: [stepRow({ clientId: "ready" })],
      goalOverrides: { status: "completed" },
    });
    const listed = await listReadyGoalPlanSteps(
      fixture.prisma as unknown as Prisma.TransactionClient,
      goal.id,
    );
    expect(listed).toEqual([]);
  });

  it("hands a step out exactly once across repeated claims", async () => {
    const row = stepRow({ clientId: "ready" });
    const fixture = planFixture({ steps: [row] });
    const tx = fixture.tx as unknown as Prisma.TransactionClient;
    const first = await markGoalPlanStepDispatched(tx, {
      stepRowId: row.id,
      runId: "run-1",
      delegationId: "delegation-1",
      at: new Date(),
    });
    const second = await markGoalPlanStepDispatched(tx, {
      stepRowId: row.id,
      runId: "run-2",
      delegationId: "delegation-2",
      at: new Date(),
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(row.status).toBe("active");
    expect(row.dispatchRunId).toBe("run-1");
    expect(row.dispatch).toMatchObject({ runId: "run-1", delegationId: "delegation-1" });
  });

  it("recovers after a restart: an undispatched ready step is listed again", async () => {
    const ready = stepRow({ clientId: "ready" });
    const fixture = planFixture({ steps: [ready] });
    const tx = fixture.prisma as unknown as Prisma.TransactionClient;
    // First attempt crashes before the marker commits: the row stays pending
    // with no dispatch, so the next sweep offers it again.
    expect((await listReadyGoalPlanSteps(tx, goal.id)).map((row) => row.clientId)).toEqual([
      "ready",
    ]);
    await markGoalPlanStepDispatched(tx, {
      stepRowId: ready.id,
      runId: "run-1",
      delegationId: "delegation-1",
      at: new Date(),
    });
    expect(await listReadyGoalPlanSteps(tx, goal.id)).toEqual([]);
  });
});

describe("step outcome recording", () => {
  it("refuses a bot outcome without a record of the goal's work", async () => {
    const row = stepRow({ clientId: "active-step", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [row] });
    await expect(
      recordGoalPlanStepOutcome(
        fixture.prisma,
        {
          scope: {
            spaceId: owner.spaceId,
            userId: owner.userId,
            coordinatorBotId: "bot-chief",
            threadId: goal.threadId,
          },
          goalId: goal.id,
        },
        { stepId: "active-step", baseRevision: 3, support: [] },
      ),
    ).rejects.toMatchObject({ reason: "missing-support" });
  });

  it("records the owner's attestation on their own step without support links", async () => {
    const row = stepRow({ clientId: "mine", ownerId: owner.userId, ownerIsUser: true });
    const fixture = planFixture({ steps: [row] });
    await recordGoalPlanStepOutcome(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "mine", baseRevision: 3, support: [] },
    );
    expect(row.status).toBe("done");
    expect(row.outcome).toMatchObject({ actorId: owner.userId, support: [] });
    expect(fixture.currentGoal.planRevision).toBe(4);
  });

  it("refuses to re-record a settled step", async () => {
    const row = stepRow({
      clientId: "done-step",
      status: "done",
      outcome: { actorId: owner.userId, support: [], recordedAt: new Date().toISOString() },
    });
    const fixture = planFixture({ steps: [row] });
    await expect(
      recordGoalPlanStepOutcome(
        fixture.prisma,
        { actor: owner },
        { goalId: goal.id, stepId: "done-step", baseRevision: 3, support: [] },
      ),
    ).rejects.toMatchObject({ reason: "step-settled" });
  });

  it("accepts a bot outcome that names a run of this goal's work", async () => {
    const row = stepRow({ clientId: "active-step", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [row] });
    fixture.state.supportRun = {
      id: "run-1",
      spaceId: owner.spaceId,
      userId: owner.userId,
      goalId: goal.id,
      delegationRootTaskId: goal.rootTaskId,
    };
    await recordGoalPlanStepOutcome(
      fixture.prisma,
      {
        scope: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          coordinatorBotId: "bot-chief",
          threadId: goal.threadId,
        },
        goalId: goal.id,
      },
      {
        stepId: "active-step",
        baseRevision: 3,
        support: [{ kind: "run", recordId: "run-1", revision: null }],
      },
    );
    expect(row.status).toBe("done");
    expect(row.outcome).toMatchObject({
      actorId: "bot-chief",
      support: [{ kind: "run", recordId: "run-1" }],
    });
  });
});

describe("step cancellation and reopening", () => {
  it("cancels an outstanding step and records the revision", async () => {
    const row = stepRow({ clientId: "active-step", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [row] });
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "active-step", baseRevision: 3, action: "cancel" },
    );
    expect(row.status).toBe("cancelled");
    expect(fixture.currentGoal.planRevision).toBe(4);
  });

  it("refuses to cancel finished work; reopening it clears the outcome and dispatch", async () => {
    const row = stepRow({
      clientId: "done-step",
      status: "done",
      outcome: { actorId: owner.userId, support: [], recordedAt: new Date().toISOString() },
      dispatchRunId: "run-1",
      dispatch: {
        runId: "run-1",
        delegationId: "delegation-1",
        dispatchedAt: new Date().toISOString(),
      },
    });
    const fixture = planFixture({ steps: [row] });
    await expect(
      settleGoalPlanStep(
        fixture.prisma,
        { actor: owner },
        { goalId: goal.id, stepId: "done-step", baseRevision: 3, action: "cancel" },
      ),
    ).rejects.toMatchObject({ reason: "step-settled" });
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "done-step", baseRevision: 3, action: "reopen" },
    );
    expect(row.status).toBe("pending");
    expect(row.outcome).toBeNull();
    expect(row.dispatchRunId).toBeNull();
    expect(row.dispatch).toBeNull();
  });

  it("refuses to reopen a step whose dispatch is still in flight", async () => {
    const row = stepRow({ clientId: "active-step", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [row] });
    fixture.state.supportRun = { id: "run-1", status: "running" };
    await expect(
      settleGoalPlanStep(
        fixture.prisma,
        { actor: owner },
        { goalId: goal.id, stepId: "active-step", baseRevision: 3, action: "reopen" },
      ),
    ).rejects.toMatchObject({ reason: "step-in-flight" });
    // The refusal leaves the dispatch marker in place, so no second worker
    // becomes eligible for the same work.
    expect(row.status).toBe("active");
    expect(row.dispatchRunId).toBe("run-1");
    const listed = await listReadyGoalPlanSteps(
      fixture.prisma as unknown as Prisma.TransactionClient,
      goal.id,
    );
    expect(listed).toEqual([]);
  });

  it("reopens a step whose dispatch already settled", async () => {
    const row = stepRow({ clientId: "active-step", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [row] });
    fixture.state.supportRun = { id: "run-1", status: "failed" };
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "active-step", baseRevision: 3, action: "reopen" },
    );
    expect(row.status).toBe("pending");
    expect(row.dispatchRunId).toBeNull();
  });

  it("reopens a done step as blocked when a prerequisite was cancelled", async () => {
    const base = stepRow({ clientId: "base", status: "cancelled" });
    const row = stepRow({
      clientId: "next",
      status: "done",
      outcome: { actorId: owner.userId, support: [], recordedAt: new Date().toISOString() },
      prerequisiteIds: ["base"],
    });
    const fixture = planFixture({ steps: [base, row] });
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "next", baseRevision: 3, action: "reopen" },
    );
    expect(row.status).toBe("blocked");
  });
});

describe("dependent statuses after step transitions", () => {
  it("blocks dependents when their prerequisite is cancelled", async () => {
    const base = stepRow({ clientId: "base" });
    const next = stepRow({ clientId: "next", prerequisiteIds: ["base"] });
    const fixture = planFixture({ steps: [base, next] });
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "base", baseRevision: 3, action: "cancel" },
    );
    expect(fixture.steps.find((row) => row.clientId === "base")?.status).toBe("cancelled");
    expect(fixture.steps.find((row) => row.clientId === "next")?.status).toBe("blocked");
  });

  it("unblocks a dependent when its prerequisite's outcome is recorded", async () => {
    const base = stepRow({ clientId: "base", ownerId: owner.userId, ownerIsUser: true });
    const next = stepRow({ clientId: "next", prerequisiteIds: ["base"], status: "blocked" });
    const fixture = planFixture({ steps: [base, next] });
    await recordGoalPlanStepOutcome(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "base", baseRevision: 3, support: [] },
    );
    expect(fixture.steps.find((row) => row.clientId === "base")?.status).toBe("done");
    expect(fixture.steps.find((row) => row.clientId === "next")?.status).toBe("pending");
  });

  it("unblocks dependents when a cancelled prerequisite is reopened", async () => {
    const base = stepRow({ clientId: "base", status: "cancelled" });
    const next = stepRow({ clientId: "next", prerequisiteIds: ["base"], status: "blocked" });
    const fixture = planFixture({ steps: [base, next] });
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "base", baseRevision: 3, action: "reopen" },
    );
    expect(fixture.steps.find((row) => row.clientId === "base")?.status).toBe("pending");
    expect(fixture.steps.find((row) => row.clientId === "next")?.status).toBe("pending");
  });
});

describe("owner step actions wake the coordinator", () => {
  it("queues the coordinator wake after the owner records a step outcome", async () => {
    const row = stepRow({ clientId: "mine", ownerId: owner.userId, ownerIsUser: true });
    const fixture = planFixture({ steps: [row], wakeGroup: true });
    await recordGoalPlanStepOutcome(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "mine", baseRevision: 3, support: [] },
    );
    const wake = vi.mocked(fixture.tx.run.create).mock.calls[0]?.[0] as {
      data: { clientNonce: string; trigger: string };
    };
    expect(wake.data.clientNonce).toBe(`goal-plan:${goal.id}:4`);
    expect(wake.data.trigger).toBe("follow_up");
  });

  it("queues the coordinator wake after the owner cancels or reopens a step", async () => {
    const row = stepRow({ clientId: "active-step", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [row], wakeGroup: true });
    fixture.state.supportRun = { id: "run-1", status: "failed" };
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "active-step", baseRevision: 3, action: "cancel" },
    );
    expect(vi.mocked(fixture.tx.run.create).mock.calls[0]?.[0]).toMatchObject({
      data: { clientNonce: `goal-plan:${goal.id}:4` },
    });
    vi.mocked(fixture.tx.run.create).mockClear();
    await settleGoalPlanStep(
      fixture.prisma,
      { actor: owner },
      { goalId: goal.id, stepId: "active-step", baseRevision: 4, action: "reopen" },
    );
    expect(vi.mocked(fixture.tx.run.create).mock.calls[0]?.[0]).toMatchObject({
      data: { clientNonce: `goal-plan:${goal.id}:5` },
    });
  });

  it("does not queue a wake for the chief's own step actions", async () => {
    const row = stepRow({ clientId: "active-step", status: "active", dispatchRunId: "run-1" });
    const fixture = planFixture({ steps: [row], wakeGroup: true });
    fixture.state.supportRun = {
      id: "run-1",
      spaceId: owner.spaceId,
      userId: owner.userId,
      goalId: goal.id,
      delegationRootTaskId: goal.rootTaskId,
    };
    await recordGoalPlanStepOutcome(
      fixture.prisma,
      {
        scope: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          coordinatorBotId: "bot-chief",
          threadId: goal.threadId,
        },
        goalId: goal.id,
      },
      {
        stepId: "active-step",
        baseRevision: 3,
        support: [{ kind: "run", recordId: "run-1", revision: null }],
      },
    );
    expect(fixture.tx.run.create).not.toHaveBeenCalled();
  });
});

describe("conflict error vocabulary", () => {
  it("exposes refusal reasons for the API conflict mapping", () => {
    const conflict = new GoalPlanConflict("dependency-cycle");
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.reason).toBe("dependency-cycle");
    expect(conflict.message).toContain("cycle");
  });
});
