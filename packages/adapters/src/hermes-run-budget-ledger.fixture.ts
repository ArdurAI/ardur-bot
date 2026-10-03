import type { AgentUsage } from "@ardurbot/adapter-kit";
import { DELEGATION_LIMITS } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { sizeDelegationRootForAsk } from "@ardurbot/db";
import { vi } from "vitest";
import { recordBrokerRunUsage } from "./run-usage.js";

/** Storage only: admission, accounting and ask resizing all run production code. */
export function brokerLedgerFixture(patch: { goal?: boolean; used?: number } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const run = {
    id: "fixture-run",
    spaceId: "fixture-space",
    userId: "fixture-user",
    botId: "fixture-bot",
    threadId: "fixture-thread",
    taskId: "fixture-root",
    delegationRootTaskId: null,
    delegationId: null,
    goalId: patch.goal ? "fixture-goal" : null,
    status: "running",
    leaseOwner: "fixture-worker",
    leaseFence: 1,
    runtimePin: { runtimeKind: "hermes", provider: "openai-compatible", modelId: "glm-5.3" },
    createdAt: new Date(),
  };
  const root = {
    rootTaskId: run.taskId,
    coordinatorThreadId: run.threadId,
    tokenLimit: DELEGATION_LIMITS.tokens as number,
    usedTokens: patch.used ?? 0,
    reservedTokens: 0,
    maxConcurrent: DELEGATION_LIMITS.concurrent as number,
    activeDescendants: 0,
    cancelRequestedAt: null as Date | null,
    deadlineAt: new Date(Date.now() + 60_000),
  };
  function updateRoot({ data }: { data: Record<string, unknown> }) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "object" && value !== null && "increment" in value) {
        const field = key as "usedTokens" | "reservedTokens";
        root[field] += Number(value.increment);
      } else Object.assign(root, { [key]: value });
    }
    return structuredClone(root);
  }
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findUnique: vi.fn(async () => structuredClone(run)),
      findUniqueOrThrow: vi.fn(async () => structuredClone(run)),
    },
    task: { findFirst: vi.fn(async () => ({ id: run.taskId })) },
    teamGoal: { findUnique: vi.fn(async () => (run.goalId ? { id: run.goalId } : null)) },
    delegationRoot: {
      findUnique: vi.fn(async () => structuredClone(root)),
      upsert: vi.fn(async () => structuredClone(root)),
      update: vi.fn(async (input: { data: Record<string, unknown> }) => updateRoot(input)),
      updateMany: vi.fn(async (input: { data: Record<string, unknown> }) => {
        updateRoot(input);
        return { count: 1 };
      }),
    },
    usageRecord: {
      findUnique: vi.fn(async ({ where }: { where: { requestKey: string } }) =>
        structuredClone(
          [...rows.values()].find((row) => row.requestKey === where.requestKey) ?? null,
        ),
      ),
      findMany: vi.fn(async () =>
        [...rows.values()].map((row) => ({
          ...structuredClone(row),
          observations: [...receipts.values()]
            .filter((receipt) => receipt.usageRecordId === row.id)
            .sort((a, b) => Number(a.sequence) - Number(b.sequence))
            .map((receipt) => structuredClone(receipt)),
        })),
      ),
      aggregate: vi.fn(async () => ({
        _sum: {
          inputTokens:
            (patch.used ?? 0) +
            [...rows.values()].reduce((sum, row) => sum + Number(row.inputTokens), 0),
          outputTokens: [...rows.values()].reduce((sum, row) => sum + Number(row.outputTokens), 0),
        },
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `usage-${rows.size + 1}` };
        rows.set(row.id, row);
        return structuredClone(row);
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.get(where.id);
          if (!row) throw new Error("Missing fixture usage row");
          Object.assign(row, data);
          return structuredClone(row);
        },
      ),
    },
    requestUsageObservation: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { usageRecordId_sequence: { usageRecordId: string; sequence: number } };
        }) => {
          const { usageRecordId, sequence } = where.usageRecordId_sequence;
          return structuredClone(receipts.get(`${usageRecordId}:${sequence}`) ?? null);
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = `${data.usageRecordId}:${data.sequence}`;
        const receipt = { ...data, id: `receipt-${key}` };
        receipts.set(key, receipt);
        return structuredClone(receipt);
      }),
    },
    botMessageDelivery: { findMany: vi.fn(async () => []) },
    thread: { update: vi.fn(async () => ({ nextEventSeq: receipts.size + 1 })) },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "fixture-event",
      })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaClient;
  const events = { append: vi.fn(), notify: vi.fn() };
  return {
    root,
    run,
    rows,
    receipts,
    tx,
    record: (usage: AgentUsage) =>
      recordBrokerRunUsage({ prisma, events }, run, usage, {
        leaseOwner: run.leaseOwner,
        leaseFence: run.leaseFence,
        runtimePin: run.runtimePin,
      }),
    ask: (memberTokens: number[]) =>
      sizeDelegationRootForAsk(tx as unknown as Prisma.TransactionClient, {
        runId: run.id,
        memberTokens,
      }),
  };
}
