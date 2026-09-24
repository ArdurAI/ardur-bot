import type { DelegationSnapshot } from "@ardurbot/contracts";
import { ALL_DEVICE_SCOPES, DELEGATION_LIMITS, TaskCardSchema } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  acceptDelegation,
  admitDelegation,
  DelegationAdmissionError,
  finishDelegation,
  requestCancel,
} from "./delegation.js";
import { rejectDelegation } from "./delegation-rework.js";
import { deviceDigest } from "./device-grants.js";
import { startDelegation, updateWorkerTask } from "./task-cards.js";

const snapshot: DelegationSnapshot = {
  pin: {
    runtimeKind: "pi",
    provider: "fixture",
    modelId: "fixture",
    effort: "high",
    credentialId: "connection",
    revision: 3,
  },
  computer: { id: "computer", mode: "team", kind: "test" },
  destination: { host: "localhost", local: true },
};
const input = {
  spaceId: "space",
  userId: "owner",
  parentRunId: "parent",
  actingBotId: "worker",
  actingName: "Worker",
  kind: "message" as const,
  admissionKey: "one",
  prompt: "Review",
  snapshot,
};
// Separate client handles share this durable store; only the transaction lock serializes admission.
function fixture() {
  let state: { root: any; rows: any[]; runs: any[] } = {
    root: null,
    rows: [],
    runs: [
      {
        id: "parent",
        taskId: "root",
        botId: "coordinator",
        threadId: "thread",
        spaceId: "space",
        userId: "owner",
        runtimePin: snapshot.pin,
        status: "running",
        createdAt: new Date(),
        remoteDeviceGrantIds: [],
      },
    ],
  };
  const policies: any[] = [];
  const bot = {
    id: "coordinator",
    name: "Coordinator",
    computerId: "computer",
    computer: { scope: "team", kind: "test" },
    allowedModelDestinations: null,
  };
  const assignments = new Map([
    ["coordinator", ["shared"]],
    ["worker", ["shared", "private"]],
  ]);
  const apply = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data))
      row[key] =
        value && typeof value === "object" && "increment" in value
          ? (row[key] ?? 0) + value.increment
          : value && typeof value === "object" && "decrement" in value
            ? row[key] - Number(value.decrement)
            : value;
    return row;
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    usageRecord: {
      aggregate: vi.fn(async () => ({ _sum: { inputTokens: 0, outputTokens: 0 } })),
    },
    spaceMember: { count: vi.fn(async () => 1) },
    artifact: {
      findFirstOrThrow: vi.fn(async ({ where }) => {
        if (where.id !== "artifact") throw new Error("not found");
        return { id: "artifact" };
      }),
    },
    externalEffect: { findFirst: vi.fn(async () => null as unknown) },
    task: { create: vi.fn(async ({ data }) => ({ id: "rework-task", ...data })) },
    run: {
      findFirstOrThrow: vi.fn(async ({ where }) => state.runs.find((row) => row.id === where.id)),
      findUnique: vi.fn(async ({ where }) => state.runs.find((row) => row.id === where.id)),
      create: vi.fn(async ({ data }) => {
        const row = { id: "rework-run", ...data };
        state.runs.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) =>
        apply(
          state.runs.find((row) => row.id === where.id),
          data,
        ),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }) => state.runs.find((row) => row.id === where.id)),
      updateMany: vi.fn(async ({ data }) => {
        for (const run of state.runs) apply(run, data);
        return { count: state.runs.length };
      }),
    },
    bot: {
      findFirstOrThrow: vi.fn(async ({ where }) => ({
        ...bot,
        id: where.id,
        thread: { id: "worker-thread" },
      })),
    },
    space: { findUniqueOrThrow: vi.fn(async () => ({ allowedModelDestinations: null })) },
    connection: { findMany: vi.fn(async () => []) },
    capabilityInstall: { findMany: vi.fn(async () => []) },
    remoteAuthorityPolicy: { findMany: vi.fn(async () => policies) },
    botMcpServer: {
      findMany: vi.fn(async ({ where }) =>
        (assignments.get(where.botId) ?? []).map((serverId) => ({
          serverId,
          allowedTools: ["read"],
          allowAllTools: false,
          needsReview: false,
        })),
      ),
    },
    delegationRoot: {
      upsert: vi.fn(
        async ({ create }) =>
          (state.root ??= {
            totalDescendants: 0,
            activeDescendants: 0,
            reservedTokens: 0,
            usedTokens: 0,
            maxDepth: 1,
            maxConcurrent: 4,
            maxHops: 6,
            maxDescendants: 12,
            tokenLimit: 120000,
            ...create,
          }),
      ),
      update: vi.fn(async ({ data }) => apply(state.root, data)),
      findFirstOrThrow: vi.fn(async () => state.root),
      findUniqueOrThrow: vi.fn(async () => state.root),
    },
    delegation: {
      findMany: vi.fn(async ({ where }) =>
        state.rows.filter(
          (row) => row.rootTaskId === where.rootTaskId && where.status.in.includes(row.status),
        ),
      ),
      findUnique: vi.fn(
        async ({ where }) =>
          state.rows.find((row) => row.admissionKey === where.admissionKey) ?? null,
      ),
      findUniqueOrThrow: vi.fn(async ({ where }) => state.rows.find((row) => row.id === where.id)),
      findFirstOrThrow: vi.fn(async ({ where }) => state.rows.find((row) => row.id === where.id)),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `delegation-${state.rows.length}`,
          status: "queued",
          usedTokens: 0,
          ...data,
        };
        state.rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) =>
        apply(
          state.rows.find((row) => row.id === where.id),
          data,
        ),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const row of state.rows)
          if (
            (!where.id || row.id === where.id) &&
            (typeof where.status === "string"
              ? row.status === where.status
              : where.status.in.includes(row.status))
          ) {
            apply(row, data);
            count++;
          }
        return { count };
      }),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })) },
    message: {
      create: vi.fn(async ({ data }) => ({ id: "summary", ...data })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: "summary",
        blocks: [
          { kind: "text", text: "Coordinator → Worker: completed, awaiting acceptance.\nReviewed" },
        ],
      })),
      update: vi.fn(async ({ data }) => ({ id: "summary", ...data })),
    },
    event: { create: vi.fn(async ({ data }) => data) },
  };
  let lock = Promise.resolve();
  const worker = () =>
    ({
      ...tx,
      $transaction: async (fn: (tx: Prisma.TransactionClient) => unknown) => {
        const prior = lock;
        let unlock!: () => void;
        lock = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        await prior;
        const backup = structuredClone(state);
        try {
          return await fn(tx as unknown as Prisma.TransactionClient);
        } catch (error) {
          state = backup;
          throw error;
        } finally {
          unlock();
        }
      },
    }) as unknown as PrismaClient;
  const admit = (patch = {}, db = worker()) =>
    db.$transaction(async (t) => {
      const row = await admitDelegation(t, { ...input, ...patch });
      row.runId = `run-${row.id}`;
      state.runs.push({
        id: row.runId,
        delegationId: row.id,
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.actingBotId,
        threadId: "worker-thread",
        status: "running",
        remoteDeviceGrantIds: [],
      });
      return row;
    });
  return { worker, admit, tx, state: () => state, policies, bot };
}
describe("transactional delegation admission", () => {
  it("shares caps across two worker clients, persists counters, and deduplicates retries", async () => {
    const f = fixture(),
      a = f.worker(),
      b = f.worker();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => f.admit({ admissionKey: `key-${i}` }, i % 2 ? a : b)),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(f.state().root).toMatchObject({
      activeDescendants: 4,
      totalDescendants: 4,
      reservedTokens: 40000,
    });
    expect(f.state().runs).toHaveLength(5);
    expect(f.tx.$queryRaw).toHaveBeenCalled();
    const row = await a.$transaction((tx) =>
      admitDelegation(tx, { ...input, admissionKey: "key-0" }),
    );
    expect(row.id).toBe("delegation-0");
    expect(f.state().root.totalDescendants).toBe(4);
  });
  it.each([
    ["depth-exceeded", { maxDepth: 0 }],
    ["hops-exceeded", { maxHops: 0 }],
    ["descendants-exceeded", { maxDescendants: 0 }],
    ["budget-exhausted", { tokenLimit: 0 }],
    ["deadline-passed", { deadlineAt: new Date(0) }],
  ])("refuses %s without a run or budget reservation", async (code, patch) => {
    const f = fixture();
    await f.admit();
    Object.assign(f.state().root, patch);
    const before = structuredClone(f.state());
    await expect(f.admit({ admissionKey: "second" })).rejects.toMatchObject({ problem: { code } });
    expect(f.state()).toEqual(before);
  });
  it("rejects A to B to A as a cycle before depth", async () => {
    const f = fixture();
    const first = await f.admit();
    f.state().runs[0].delegationId = first.id;
    f.state().runs[0].botId = "worker";
    await expect(
      f.admit({ admissionKey: "cycle", actingBotId: "coordinator" }),
    ).rejects.toMatchObject({ problem: { code: "cycle" } });
  });
  it("intersects connector grants and scopes without widening", async () => {
    const f = fixture();
    f.policies.push({ layer: "bot", subjectId: "coordinator", scopes: ["ordinary", "delegate"] });
    const row = await f.admit();
    expect(row.authority).toEqual({
      scopes: ["ordinary", "delegate"],
      connectors: ["mcp:shared", "mcp:shared:read"],
    });
    f.policies[0].scopes = ["ordinary"];
    await expect(f.admit({ admissionKey: "denied" })).rejects.toMatchObject({
      problem: { code: "authority-exceeded" },
    });
  });
  it.each([
    { host: "api.example.test", local: false },
    { host: null, local: false },
  ])("denies nonlocal and unknown destinations under local policy", async (destination) => {
    const f = fixture();
    f.bot.allowedModelDestinations = { mode: "local" } as never;
    await expect(f.admit({ snapshot: { ...snapshot, destination } })).rejects.toMatchObject({
      problem: { code: "locality-denied" },
    });
    expect(f.state().root).toBeNull();
    expect(f.state().rows).toHaveLength(0);
  });
  it("records pin differences and refuses changed helper binding", async () => {
    const f = fixture();
    const row = await f.admit({
      snapshot: { ...snapshot, pin: { ...snapshot.pin, modelId: "reviewer" } },
    });
    expect(row.differences.join()).toContain("reviewer");
    await expect(
      f.admit({
        admissionKey: "helper",
        kind: "helper",
        snapshot: { ...snapshot, pin: { ...snapshot.pin, credentialId: "other" } },
      }),
    ).rejects.toBeInstanceOf(DelegationAdmissionError);
  });
  it("marks cancellation separately, retains capacity until confirmation and writes one summary", async () => {
    const f = fixture();
    const row = await f.admit();
    const db = f.worker();
    await requestCancel(db, { spaceId: "space", userId: "owner" }, "root");
    expect(f.state().rows[0].status).toBe("cancel-requested");
    expect(f.state().root.activeDescendants).toBe(1);
    await db.$transaction((tx) => finishDelegation(tx, row.id, "cancelled", "Stopped"));
    await db.$transaction((tx) => finishDelegation(tx, row.id, "cancelled", "Stopped"));
    expect(f.state().rows[0].cancelConfirmedAt).toBeInstanceOf(Date);
    expect(f.state().root.activeDescendants).toBe(0);
    expect(f.tx.message.create).toHaveBeenCalledOnce();
  });
  it("defaults to bounded roots", () => {
    expect(DELEGATION_LIMITS).toMatchObject({ depth: 1, concurrent: 4, hops: 6, descendants: 12 });
    expect(ALL_DEVICE_SCOPES).toContain("delegate");
  });
});

it("writes one completion summary and changes it on explicit acceptance", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Reviewed"));
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Duplicate"));
  expect(f.state().rows[0].status).toBe("completed");
  expect(f.tx.message.create).toHaveBeenCalledOnce();
  expect(f.tx.message.create.mock.calls[0]![0].data.blocks[0].text).toContain(
    "awaiting acceptance",
  );
  await db.$transaction((tx) =>
    acceptDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator"),
  );
  expect(f.state().rows[0].status).toBe("accepted");
  expect(f.tx.message.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { blocks: [{ kind: "text", text: "Coordinator → Worker: accepted.\nReviewed" }] },
    }),
  );
});
it("counts coordinator usage before the first handoff and rolls back an exhausted root", async () => {
  const f = fixture();
  f.tx.usageRecord.aggregate.mockResolvedValue({
    _sum: { inputTokens: 119000, outputTokens: 1000 },
  });
  await expect(f.admit()).rejects.toMatchObject({ problem: { code: "budget-exhausted" } });
  expect(f.state().root).toBeNull();
  expect(f.state().rows).toHaveLength(0);
});
it("does not let an inherited worker change the parent's computer", async () => {
  const f = fixture();
  await expect(
    f.admit({
      kind: "helper",
      snapshot: { ...snapshot, computer: { ...snapshot.computer, id: "other" } },
    }),
  ).rejects.toMatchObject({ problem: { code: "authority-exceeded" } });
  expect(f.state().rows).toHaveLength(0);
});

it("saves admission-owned fields, scoped references and optional human ownership", async () => {
  const f = fixture();
  f.tx.spaceMember.count.mockResolvedValue(2);
  const row = await f.admit({
    card: {
      goal: "Review",
      inputs: [{ type: "file", artifactId: "artifact" }],
      doneWhen: ["Checklist passes"],
      deadlineAt: null,
    },
  });
  expect(row.card).toMatchObject({
    responsibleUserId: "owner",
    requesterBotId: "coordinator",
    workerBotId: "worker",
    approvalBoundaries: row.authority,
    snapshot: row.snapshot,
  });
  expect(f.tx.artifact.findFirstOrThrow).toHaveBeenCalledWith({
    where: { id: "artifact", spaceId: "space", userId: "owner" },
  });
  await expect(
    f.admit({
      admissionKey: "other",
      card: { goal: "Review", inputs: [{ type: "file", artifactId: "foreign" }] },
    }),
  ).rejects.toThrow("not found");
});
it("updates a worker card quietly, redacts it, checks bounds and keeps acceptance separate", async () => {
  const f = fixture();
  const row = await f.admit({ card: { goal: "Review", doneWhen: ["Checklist passes"] } });
  const db = f.worker();
  await db.$transaction((tx) => startDelegation(tx, row.id));
  const update = (tool: string, args: unknown, executionId = tool) =>
    db.$transaction((tx) =>
      updateWorkerTask(tx, {
        runId: row.runId!,
        spaceId: "space",
        userId: "owner",
        botId: "worker",
        executionId,
        tool,
        args,
      }),
    );
  await update("report_progress", { text: "token=fake-sensitive-value" });
  await update("report_progress", { text: "token=fake-sensitive-value" });
  expect(
    TaskCardSchema.parse(row.card).timeline.filter((event) => event.kind === "progress"),
  ).toHaveLength(1);
  expect(JSON.stringify(row.card)).not.toContain("fake-sensitive-value");
  expect(f.tx.message.create).not.toHaveBeenCalled();
  await expect(update("report_progress", { text: "x".repeat(2001) }, "long")).rejects.toThrow();
  await expect(update("attach_artifact", { artifactId: "foreign" })).rejects.toThrow();
  await update("attach_artifact", { artifactId: "artifact" });
  await expect(update("complete_task", { summary: "Done", reports: [] })).rejects.toThrow(
    "every definition",
  );
  f.tx.externalEffect.findFirst.mockResolvedValue({ id: "approval" });
  await expect(
    update("complete_task", {
      summary: "Done",
      reports: [{ index: 0, met: true, report: "Passed" }],
    }),
  ).rejects.toThrow("waiting for approval");
  f.tx.externalEffect.findFirst.mockResolvedValue(null);
  await update("complete_task", {
    summary: "Done",
    reports: [{ index: 0, met: true, report: "Passed" }],
  });
  expect(f.state().rows[0].status).toBe("completed");
  expect(f.tx.message.create).toHaveBeenCalledOnce();
  expect(f.tx.message.create.mock.calls[0]![0].data.blocks[0].text).toContain(
    "Checklist passes: reported met — Passed",
  );
  await db.$transaction((tx) =>
    acceptDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator"),
  );
  expect(f.state().rows[0].status).toBe("accepted");
});
it("returns a completed card for rework with one more hop and a fresh bounded reservation", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "First pass"));
  f.state().runs.find((run) => run.id === row.runId).status = "completed";
  const result = await db.$transaction((tx) =>
    rejectDelegation(
      tx,
      { spaceId: "space", userId: "owner" },
      row.id,
      "coordinator",
      "Check the missing citation",
    ),
  );
  expect(result.runId).toBe("rework-run");
  expect(f.state().rows[0]).toMatchObject({ status: "queued", hop: 2, runId: "rework-run" });
  expect(f.state().root).toMatchObject({
    activeDescendants: 1,
    totalDescendants: 2,
    reservedTokens: 10000,
  });
  expect(f.state().rows[0].card.timeline.at(-1).text).toBe("Check the missing citation");
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Second pass"));
  expect(f.tx.message.create).toHaveBeenCalledOnce();
  expect(f.tx.message.update).toHaveBeenCalled();
});
it.each([
  ["hops-exceeded", { maxHops: 1 }],
  ["descendants-exceeded", { maxDescendants: 1 }],
  ["descendants-exceeded", { maxConcurrent: 0 }],
  ["budget-exhausted", { tokenLimit: 0 }],
  ["deadline-passed", { cancelRequestedAt: new Date() }],
])("refuses rework at the %s cap without reserving or queueing", async (code, patch) => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "Done"));
  Object.assign(f.state().root, patch);
  const before = structuredClone(f.state());
  await expect(
    db.$transaction((tx) =>
      rejectDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator", "Rework"),
    ),
  ).rejects.toMatchObject({ problem: { code } });
  expect(f.state()).toEqual(before);
});

it("clears a saved blocker on a new executor attempt and deduplicates start retries", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  await db.$transaction((tx) => startDelegation(tx, row.id, "attempt-1"));
  await db.$transaction((tx) =>
    updateWorkerTask(tx, {
      runId: row.runId!,
      spaceId: "space",
      userId: "owner",
      botId: "worker",
      executionId: "blocked",
      tool: "report_progress",
      args: { state: "blocked", text: "Need a source", action: "Choose a source" },
    }),
  );
  await db.$transaction((tx) => startDelegation(tx, row.id, "attempt-2"));
  await db.$transaction((tx) => startDelegation(tx, row.id, "attempt-2"));
  const timeline = TaskCardSchema.parse(row.card).timeline;
  expect(timeline.at(-1)?.kind).toBe("started");
  expect(timeline.filter((event) => event.kind === "started")).toHaveLength(2);
});

it("replays a P1 admission without inventing a historical card", async () => {
  const f = fixture();
  const row = await f.admit();
  f.state().rows[0].card = null;
  f.state().rows[0].fingerprint = deviceDigest(
    JSON.stringify([input.actingBotId, input.kind, input.prompt]),
  );
  const replay = await f.worker().$transaction((tx) => admitDelegation(tx, input));
  expect(replay.id).toBe(row.id);
  expect(replay.card).toBeNull();
  expect(f.state().root.totalDescendants).toBe(1);
});

it("ignores a late completion from an attempt superseded by rework", async () => {
  const f = fixture();
  const row = await f.admit();
  const db = f.worker();
  const oldRunId = row.runId;
  await db.$transaction((tx) => finishDelegation(tx, row.id, "completed", "First pass", oldRunId));
  f.state().runs.find((run) => run.id === oldRunId).status = "completed";
  await db.$transaction((tx) =>
    rejectDelegation(tx, { spaceId: "space", userId: "owner" }, row.id, "coordinator", "Rework"),
  );
  await db.$transaction((tx) =>
    finishDelegation(tx, row.id, "completed", "Late old result", oldRunId),
  );
  expect(f.state().rows[0].status).toBe("queued");
  expect(f.state().rows[0].result).toBeNull();
});
