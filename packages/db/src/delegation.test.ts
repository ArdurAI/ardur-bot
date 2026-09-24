import type { DelegationSnapshot } from "@ardurbot/contracts";
import { ALL_DEVICE_SCOPES, DELEGATION_LIMITS } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  acceptDelegation,
  admitDelegation,
  DelegationAdmissionError,
  finishDelegation,
  requestCancel,
} from "./delegation.js";

const snapshot: DelegationSnapshot = {
  pin: {
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
    run: {
      findUniqueOrThrow: vi.fn(async ({ where }) => state.runs.find((row) => row.id === where.id)),
      updateMany: vi.fn(async ({ data }) => {
        for (const run of state.runs) apply(run, data);
        return { count: state.runs.length };
      }),
    },
    bot: { findFirstOrThrow: vi.fn(async ({ where }) => ({ ...bot, id: where.id })) },
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
      update: vi.fn(),
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
      state.runs.push({ id: `run-${row.id}`, delegationId: row.id });
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
