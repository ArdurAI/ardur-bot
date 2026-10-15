import type { Prisma, PrismaClient } from "@ardurbot/db";
import { finalizeRun, loadGoal } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchReadyGoalPlanSteps,
  goalPlanStepPrompt,
  updateProjectPlanFromRun,
} from "./project-plan.js";

const prepareDelegation = vi.hoisted(() => vi.fn());
vi.mock("../delegation.js", () => ({
  prepareDelegation: (...args: unknown[]) => prepareDelegation(...args),
  resolveDelegationTarget: vi.fn(),
  delegationFailure: (error: unknown) => {
    throw error;
  },
}));

const secret = "fixture-secret-9f3";
const now = new Date("2030-01-01T00:00:00.000Z");

const goal = {
  id: "goal-1",
  spaceId: "space-1",
  userId: "owner-1",
  groupId: "group-1",
  threadId: "thread-1",
  coordinatorBotId: "bot-chief",
  rootTaskId: "task-root",
  objective: "Ship the report",
  doneWhen: ["Report accepted"],
  status: "running",
  planRevision: 3,
  tokenLimit: 600_000,
  perWorkerTokens: 30_000,
  maxConcurrent: 2,
  maxDescendants: 60,
  stoppedAt: null,
  boardWorkspaceId: null,
  boardItemId: null,
  untilAt: new Date("2030-01-02T00:00:00.000Z"),
  createdAt: now,
};

type StepRow = {
  id: string;
  goalId: string;
  clientId: string;
  revision: number;
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
    title: `Step ${overrides.clientId}`,
    ownerId: "bot-writer",
    ownerIsUser: false,
    condition: "Records support it",
    status: "pending",
    prerequisiteIds: [],
    outcome: null,
    dispatchRunId: null,
    dispatch: null,
    updatedAt: now,
    ...overrides,
  };
}

/** An in-memory double that runs the real @ardurbot/db plan functions. */
function planFixture(options: { steps?: StepRow[] } = {}) {
  const steps = options.steps ?? [];
  const currentGoal = { ...goal, revisions: [] as unknown[] };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    teamGoal: {
      findFirst: vi.fn(async () => currentGoal),
      findUnique: vi.fn(async () => currentGoal),
      findUniqueOrThrow: vi.fn(async () => currentGoal),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(args.data)) {
          (currentGoal as Record<string, unknown>)[key] = value;
        }
        return currentGoal;
      }),
      updateMany: vi.fn(async () => {
        currentGoal.planRevision += 1;
        return { count: 1 };
      }),
    },
    goalPlanStep: {
      findMany: vi.fn(async () => steps),
      findFirst: vi.fn(async (args: { where: { id?: string; clientId?: string } }) =>
        steps.find((row) => row.id === args.where.id || row.clientId === args.where.clientId),
      ),
      create: vi.fn(
        async (args: { data: Record<string, unknown> & { clientId: string; goalId: string } }) => {
          const row = stepRow({
            ...(args.data as Partial<StepRow>),
            clientId: args.data.clientId,
          });
          steps.push(row);
          return row;
        },
      ),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = steps.find((entry) => entry.id === args.where.id);
        if (!row) throw new Error("missing step row");
        Object.assign(row, args.data);
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
      findMany: vi.fn(async () => [{ botId: "bot-writer" }, { botId: "bot-chief" }]),
    },
    chatGroup: { findFirst: vi.fn(async () => null) },
    run: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: "wake-run",
        ...args.data,
      })),
    },
    task: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: "task-1",
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
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return {
    tx,
    prisma: prisma as unknown as PrismaClient,
    steps,
    currentGoal,
  };
}

const chiefRun = {
  id: "run-chief",
  spaceId: goal.spaceId,
  userId: goal.userId,
  threadId: goal.threadId,
  botId: goal.coordinatorBotId,
};

const dispatchDeps = (prisma: PrismaClient) =>
  ({
    prisma,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  }) as unknown as Parameters<typeof dispatchReadyGoalPlanSteps>[0];

describe("dispatch revalidation under concurrent plan edits", () => {
  function dispatchFixture(options: { outside: StepRow[]; inside: StepRow[] }) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: goal.groupId }]),
      thread: {
        update: vi.fn(async () => ({ nextEventSeq: 2, nextMessageSeq: 2 })),
      },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
      chatGroup: {
        findFirst: vi.fn(async () => ({
          id: goal.groupId,
          members: [
            { bot: { id: "bot-writer", name: "Writer" } },
            { bot: { id: "bot-other", name: "Other" } },
            { bot: { id: "bot-chief", name: "Chief" } },
          ],
        })),
        update: vi.fn(async () => ({ id: goal.groupId })),
      },
      run: {
        findFirst: vi.fn(async () => ({ id: chiefRun.id })),
        findUnique: vi.fn(async () => ({
          threadId: goal.threadId,
          status: "running",
          startedAt: now,
          originDeviceGrantId: null,
          remoteRootTaskId: null,
          delegationId: null,
          delegationRootTaskId: goal.rootTaskId,
          replySeq: null,
        })),
        update: vi.fn(async () => ({ id: chiefRun.id })),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
          id: "run-worker",
          ...args.data,
        })),
      },
      goalPlanStep: {
        findMany: vi.fn(async () => options.inside),
        findFirst: vi.fn(async (args: { where: { id?: string; clientId?: string } }) =>
          options.inside.find(
            (row) => row.id === args.where.id || row.clientId === args.where.clientId,
          ),
        ),
        updateMany: vi.fn(
          async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            const row = options.inside.find((entry) => entry.id === args.where.id);
            if (!row || row.dispatchRunId !== null) return { count: 0 };
            Object.assign(row, args.data);
            return { count: 1 };
          },
        ),
      },
      message: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
          id: "message-1",
          ...args.data,
        })),
      },
      task: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
          id: "task-worker",
          ...args.data,
        })),
      },
      delegation: {
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({ id: "delegation-1" })),
      },
    };
    const prisma = {
      teamGoal: {
        findFirst: vi.fn(async () => ({
          ...goal,
          status: "running",
          planRevision: goal.planRevision,
        })),
      },
      goalPlanStep: { findMany: vi.fn(async () => options.outside) },
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    };
    return {
      tx,
      prisma: prisma as unknown as PrismaClient,
    };
  }

  it("dispatches a ready step to the re-read owner with the re-read prompt", async () => {
    const ready = stepRow({ clientId: "a" });
    const fixture = dispatchFixture({ outside: [ready], inside: [ready] });
    prepareDelegation.mockResolvedValue({
      ok: true,
      record: { id: "delegation-1" },
      runData: {},
    });
    const result = await dispatchReadyGoalPlanSteps(
      dispatchDeps(fixture.prisma),
      chiefRun,
      goal.id,
    );
    expect(result.dispatched).toBe(1);
    expect(prepareDelegation).toHaveBeenCalledTimes(1);
    const task = vi.mocked(fixture.tx.task.create).mock.calls[0]?.[0] as {
      data: { botId: string; prompt: string };
    };
    expect(task.data.botId).toBe("bot-writer");
    expect(task.data.prompt).toContain("Step a");
  });

  it("does not deadlock dispatch against worker finalization", async () => {
    const barrier = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const dispatchPaused = barrier();
    const finalizerBlocked = barrier();
    const resumeDispatch = barrier();
    const owners = new Map<string, string>();
    const waiting = new Map<string, string>();
    const released = new Map<string, ReturnType<typeof barrier>>();
    const trace: string[] = [];
    let paused = false;
    const acquire = async (transaction: string, resource: string) => {
      while (owners.has(resource) && owners.get(resource) !== transaction) {
        const owner = owners.get(resource)!;
        waiting.set(transaction, owner);
        if (waiting.get(owner) === transaction) throw new Error("deadlock detected");
        if (transaction === "finalizer") finalizerBlocked.resolve();
        await released.get(owner)!.promise;
        waiting.delete(transaction);
      }
      owners.set(resource, transaction);
      trace.push(`${transaction}:${resource}`);
      // Before the fix this is the thread; after it this is the worker bot.
      if (
        transaction === "dispatch" &&
        !paused &&
        (resource === "bot:bot-writer" || resource === "thread")
      ) {
        paused = true;
        dispatchPaused.resolve();
        await resumeDispatch.promise;
      }
    };
    const raw =
      (transaction: string) =>
      async (sql: TemplateStringsArray, ...values: unknown[]) => {
        const query = sql.join("");
        if (query.includes("FROM bots")) {
          const ids =
            query.includes("SELECT") && query.includes("FROM tasks")
              ? ["bot-chief"]
              : values.filter(
                  (value): value is string => typeof value === "string" && value.startsWith("bot-"),
                );
          for (const id of [...new Set(ids)].sort()) await acquire(transaction, `bot:${id}`);
        } else if (query.includes("FROM threads")) await acquire(transaction, "thread");
        else if (query.includes("FROM tasks")) await acquire(transaction, "root-task");
        else if (query.includes("chat_groups")) await acquire(transaction, "group");
        return [{ id: goal.groupId }];
      };
    const transaction = <T>(
      name: string,
      tx: Prisma.TransactionClient,
      work: (tx: Prisma.TransactionClient) => Promise<T>,
    ) => {
      released.set(name, barrier());
      return work(tx).finally(() => {
        for (const [resource, owner] of owners) if (owner === name) owners.delete(resource);
        waiting.delete(name);
        released.get(name)!.resolve();
      });
    };
    const ready = stepRow({ clientId: "draft" });
    const fixture = dispatchFixture({ outside: [ready], inside: [ready] });
    Object.assign(fixture.tx, { $queryRaw: vi.fn(raw("dispatch")) });
    const createTask = fixture.tx.task.create.getMockImplementation()!;
    fixture.tx.task.create.mockImplementation(async (args) => {
      // PostgreSQL's task.botId foreign key needs a bot key-share lock.
      await acquire("dispatch", `bot:${String(args.data.botId)}`);
      return createTask(args);
    });
    fixture.prisma.$transaction = ((work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      transaction(
        "dispatch",
        fixture.tx as unknown as Prisma.TransactionClient,
        work,
      )) as PrismaClient["$transaction"];
    prepareDelegation.mockResolvedValue({ ok: true, record: { id: "delegation-1" }, runData: {} });
    const dispatch = dispatchReadyGoalPlanSteps(dispatchDeps(fixture.prisma), chiefRun, goal.id);
    const dispatched = expect(dispatch).resolves.toEqual({ dispatched: 1 });
    await dispatchPaused.promise;
    const finalizerTx = {
      $queryRaw: raw("finalizer"),
      delegationRoot: { findUnique: async () => ({ coordinatorThreadId: goal.threadId }) },
      run: {
        findUnique: async () => ({
          delegationRootTaskId: goal.rootTaskId,
          status: "running",
          threadId: goal.threadId,
          startedAt: now,
          originDeviceGrantId: null,
          remoteRootTaskId: null,
          delegationId: null,
          replySeq: null,
        }),
        // A fenced-out completion still takes the real finalization locks.
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const finalizerDb = {
      $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        transaction("finalizer", finalizerTx as unknown as Prisma.TransactionClient, work),
    } as unknown as PrismaClient;
    const finalizing = finalizeRun(finalizerDb, {
      spaceId: goal.spaceId,
      threadId: goal.threadId,
      botId: "bot-writer",
      runId: "prior-worker",
      taskId: "prior-task",
      attemptId: "prior-attempt",
      leaseOwner: "fixture-lease",
      leaseFence: 1,
      outcome: "completed",
      blocks: [],
    });
    const finalized = expect(finalizing).resolves.toBe(false);
    await finalizerBlocked.promise;
    resumeDispatch.resolve();
    await Promise.all([dispatched, finalized]);
    expect(finalizerTx.run.updateMany).toHaveBeenCalledOnce();
    expect(fixture.tx.task.create).toHaveBeenCalledOnce();
    expect(trace.indexOf("dispatch:bot:bot-chief")).toBeLessThan(trace.indexOf("dispatch:group"));
    expect(trace.indexOf("dispatch:bot:bot-writer")).toBeLessThan(trace.indexOf("dispatch:thread"));
  });

  it("does not dispatch a step whose prerequisite became unfinished before the transaction", async () => {
    // Readiness saw the prerequisite done; the locked re-read sees it pending.
    const base = stepRow({ clientId: "base", status: "done" });
    const waitingOutside = stepRow({
      clientId: "next",
      prerequisiteIds: ["base"],
      revision: 4,
    });
    const baseInside = stepRow({ clientId: "base", status: "pending", revision: 4 });
    const waitingInside = stepRow({
      clientId: "next",
      prerequisiteIds: ["base"],
      revision: 4,
    });
    const fixture = dispatchFixture({
      outside: [base, waitingOutside],
      inside: [baseInside, waitingInside],
    });
    const result = await dispatchReadyGoalPlanSteps(
      dispatchDeps(fixture.prisma),
      chiefRun,
      goal.id,
    );
    expect(result.dispatched).toBe(0);
    expect(fixture.tx.task.create).not.toHaveBeenCalled();
    expect(fixture.tx.run.create).not.toHaveBeenCalled();
  });

  it("does not send a step to a superseded owner after an ownership change", async () => {
    // Readiness saw bot-writer; the locked re-read shows the plan moved the
    // step to bot-other. Nothing may go to the old owner.
    const stale = stepRow({ clientId: "a", ownerId: "bot-writer" });
    const moved = stepRow({ clientId: "a", ownerId: "bot-other", revision: 4 });
    const fixture = dispatchFixture({ outside: [stale], inside: [moved] });
    const result = await dispatchReadyGoalPlanSteps(
      dispatchDeps(fixture.prisma),
      chiefRun,
      goal.id,
    );
    expect(result.dispatched).toBe(0);
    expect(fixture.tx.task.create).not.toHaveBeenCalled();
    expect(fixture.tx.run.create).not.toHaveBeenCalled();
  });
});

describe("plan update secret redaction", () => {
  it("redacts free-text plan fields before persistence and before the dispatch prompt", async () => {
    const fixture = planFixture();
    const updated = await updateProjectPlanFromRun(dispatchDeps(fixture.prisma), chiefRun, {
      goalId: goal.id,
      threadId: goal.threadId,
      secrets: [secret],
      raw: {
        baseRevision: 3,
        steps: [
          {
            id: "a",
            title: `Use ${secret} in the draft`,
            ownerId: "bot-writer",
            ownerIsUser: false,
            condition: `The draft never leaks ${secret}`,
            prerequisiteIds: [],
          },
        ],
      },
    });
    expect(updated.ok).toBe(true);
    const stored = fixture.steps.find((row) => row.clientId === "a");
    expect(stored?.title).toBe("Use [redacted] in the draft");
    expect(stored?.condition).toBe("The draft never leaks [redacted]");
    // The secret never reaches durable storage...
    expect(JSON.stringify(fixture.steps)).not.toContain(secret);
    // ...and the prompt and handoff text the dispatcher builds from the stored
    // rows carry only the redacted copy.
    expect(goalPlanStepPrompt(stored!)).not.toContain(secret);
    expect(JSON.stringify(fixture.steps.map((row) => goalPlanStepPrompt(row)))).not.toContain(
      secret,
    );
  });
});

it.each(["id", "prerequisiteIds"])(
  "refuses a known secret in %s before storage or dispatch",
  async (field) => {
    const fixture = planFixture();
    const deps = dispatchDeps(fixture.prisma);
    const result = await updateProjectPlanFromRun(deps, chiefRun, {
      goalId: goal.id,
      threadId: goal.threadId,
      secrets: [secret],
      raw: {
        baseRevision: 3,
        steps: [
          {
            id: secret,
            title: "Draft",
            ownerId: "bot-writer",
            ownerIsUser: false,
            condition: "Saved",
            prerequisiteIds: [],
            ...(field === "prerequisiteIds" ? { id: "draft", prerequisiteIds: [secret] } : {}),
          },
        ],
      },
    });
    expect(result).toEqual({ ok: false, error: "Plan identifiers must not contain secrets" });
    expect(fixture.steps).toEqual([]);
    expect(fixture.tx.goalPlanStep.create).not.toHaveBeenCalled();
    expect(fixture.tx.event.create).not.toHaveBeenCalled();
    expect(fixture.tx.task.create).not.toHaveBeenCalled();
    expect(deps.events.notify).not.toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(await loadGoal(fixture.prisma, { id: goal.id }))).not.toContain(secret);
  },
);
