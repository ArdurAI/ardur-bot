import type { DelegationSnapshot } from "@ardurbot/contracts";
import { vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { admitDelegation } from "./delegation.js";

export const snapshot: DelegationSnapshot = {
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
export const input = {
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
export function fixture() {
  let state: {
    root: any;
    rows: any[];
    runs: any[];
    comparisons: any[];
    executions: any[];
    messages: any[];
    usage: any[];
  } = {
    comparisons: [],
    executions: [],
    messages: [],
    usage: [],
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
