import type { Prisma, PrismaClient } from "@ardurbot/db";
import { DELEGATION_ADMISSION_TRANSACTION } from "@ardurbot/db";
import { describe, expect, it } from "vitest";
import { admitRunHelper } from "./delegation-helpers.js";

const PARENT = {
  id: "parent-run",
  taskId: "root-task",
  delegationRootTaskId: "root-task",
  botId: "coordinator",
  threadId: "coordinator-thread",
  spaceId: "space",
  userId: "owner",
  status: "running",
  runtimePin: {
    runtimeKind: "pi",
    provider: "fixture",
    modelId: "fixture",
    effort: "high",
    credentialId: "connection",
    revision: 3,
  },
  createdAt: new Date(),
  remoteDeviceGrantIds: [],
};

function expiredTransaction(timeout: number, elapsed: number) {
  return new Error(
    `A query cannot be executed on an expired transaction. The timeout for this transaction was ${timeout} ms, however ${Math.round(elapsed)} ms passed`,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-memory stand-in for the admission path. `$transaction` emulates Prisma's
 * interactive-transaction cap: without an explicit `timeout` option the transaction
 * expires 5 s in and the next query on it fails, exactly like the flaky e2e server log.
 */
function fakeDb(options: { slowWorkMs: number; ignoreTransactionOptions?: boolean }) {
  let root: Record<string, unknown> | null = null;
  const delegations: Array<Record<string, unknown>> = [];
  const bot = {
    id: "coordinator",
    name: "Coordinator",
    computerId: "computer",
    computer: { scope: "team", kind: "test" },
    allowedModelDestinations: null,
    archivedAt: null,
  };
  let delayed = false;
  const slowWork = async () => {
    if (delayed || options.slowWorkMs === 0) return;
    delayed = true;
    await sleep(options.slowWorkMs);
  };
  const apply = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      const patch = value as Record<string, unknown> | null;
      row[key] =
        patch && typeof patch === "object" && "increment" in patch
          ? Number(row[key] ?? 0) + Number(patch.increment)
          : patch && typeof patch === "object" && "decrement" in patch
            ? Number(row[key] ?? 0) - Number(patch.decrement)
            : value;
    }
    return row;
  };
  const tx = {
    $queryRaw: async () => [],
    run: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === PARENT.id ? PARENT : undefined,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        if (where.id !== PARENT.id) throw new Error("run not found");
        return PARENT;
      },
    },
    bot: {
      findFirstOrThrow: async () => {
        await slowWork();
        return bot;
      },
    },
    space: {
      findUniqueOrThrow: async () => ({ id: "space", allowedModelDestinations: null }),
    },
    usageRecord: {
      aggregate: async () => ({ _sum: { inputTokens: 0, outputTokens: 0 } }),
    },
    teamGoal: { findUnique: async () => null },
    delegationRoot: {
      findUnique: async () => root,
      findUniqueOrThrow: async () => {
        if (!root) throw new Error("delegation root not found");
        return root;
      },
      upsert: async ({ create }: { create: Record<string, unknown> }) =>
        (root ??= {
          totalDescendants: 0,
          activeDescendants: 0,
          reservedTokens: 0,
          usedTokens: 0,
          maxDepth: 1,
          maxConcurrent: 4,
          maxHops: 6,
          maxDescendants: 12,
          tokenLimit: 120_000,
          cancelRequestedAt: null,
          ...create,
        }),
      update: async ({ data }: { data: Record<string, unknown> }) => apply(root!, data),
    },
    remoteAuthorityPolicy: { findMany: async () => [] },
    connection: { findMany: async () => [] },
    capabilityInstall: { findMany: async () => [] },
    mcpServer: { findMany: async () => [] },
    botMcpServer: { findMany: async () => [] },
    spaceMember: { count: async () => 1 },
    delegation: {
      findUnique: async () => null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = delegations.find((delegation) => delegation.id === where.id);
        if (!row) throw new Error("delegation not found");
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `delegation-${delegations.length}`,
          status: "queued",
          usedTokens: 0,
          ...data,
        };
        delegations.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        apply(delegations.find((delegation) => delegation.id === where.id)!, data),
    },
    thread: { update: async () => ({ nextEventSeq: 1 }) },
    event: { create: async ({ data }: { data: unknown }) => data },
  };
  let transactionOptions: { timeout?: number; maxWait?: number } | undefined;
  const client = {
    transactionOptions: () => transactionOptions,
    $transaction: async (
      fn: (txClient: Prisma.TransactionClient) => Promise<unknown>,
      txOptions?: { timeout?: number; maxWait?: number },
    ) => {
      transactionOptions = txOptions;
      const timeout =
        !options.ignoreTransactionOptions && txOptions?.timeout !== undefined
          ? txOptions.timeout
          : 5_000;
      const startedAt = Date.now();
      const guard = <T extends object>(target: T): T =>
        new Proxy(target, {
          get(object, key, receiver) {
            const value = Reflect.get(object, key, receiver);
            if (typeof value !== "function") return value;
            return async (...args: unknown[]) => {
              const elapsed = Date.now() - startedAt;
              if (elapsed > timeout) throw expiredTransaction(timeout, elapsed);
              return (value as (...inner: unknown[]) => unknown).apply(object, args);
            };
          },
        });
      return fn(guard(tx) as unknown as Prisma.TransactionClient);
    },
  };
  return {
    client: client as unknown as PrismaClient & {
      transactionOptions(): { timeout?: number; maxWait?: number } | undefined;
    },
    delegations: () => delegations,
    root: () => root,
  };
}

describe("admitRunHelper transaction budget", () => {
  it("admits a helper when in-transaction work outlives Prisma's default 5 s cap", {
    timeout: 30_000,
  }, async () => {
    const db = fakeDb({ slowWorkMs: 6_000 });
    const admitted = await admitRunHelper(
      db.client,
      { id: PARENT.id, spaceId: "space", userId: "owner", botId: "coordinator" },
      "execution-1",
      "Helper",
      "Summarize the thread",
    );
    expect(admitted).toMatchObject({ ok: true, id: "delegation-0" });
    expect(db.client.transactionOptions()).toEqual(DELEGATION_ADMISSION_TRANSACTION);
    expect(db.delegations()[0]).toMatchObject({ status: "running" });
    expect(db.root()).toMatchObject({ totalDescendants: 1, activeDescendants: 1 });
  });

  it("still fails with an expired transaction when the explicit budget is absent", {
    timeout: 30_000,
  }, async () => {
    // The pre-fix wiring: the same slow in-transaction work exceeds Prisma's default
    // cap before the delegation-root lock is taken, so the admission must fail.
    const db = fakeDb({ slowWorkMs: 6_000, ignoreTransactionOptions: true });
    await expect(
      admitRunHelper(
        db.client,
        { id: PARENT.id, spaceId: "space", userId: "owner", botId: "coordinator" },
        "execution-1",
        "Helper",
        "Summarize the thread",
      ),
    ).rejects.toThrow(/expired transaction/);
    expect(db.delegations()).toHaveLength(0);
  });
});
