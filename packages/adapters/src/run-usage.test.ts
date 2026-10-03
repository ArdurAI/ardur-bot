import type { AgentUsage } from "@ardurbot/adapter-kit";
import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { brokerRootTokensBlock, recordRunUsage, recordStandaloneUsage } from "./run-usage.js";

it("admits a non-goal coordinator and an admitted worker when ask reservations fill the task", () => {
  expect(
    brokerRootTokensBlock({
      goal: false,
      delegated: false,
      usedTokens: 20_000,
      reservedTokens: 120_000,
      requestTokens: 8_000,
      tokenLimit: 140_000,
    }),
  ).toBe(false);
  expect(
    brokerRootTokensBlock({
      goal: false,
      delegated: true,
      usedTokens: 200_000,
      reservedTokens: 30_000,
      requestTokens: 1_000,
      tokenLimit: 120_000,
    }),
  ).toBe(false);
  expect(
    brokerRootTokensBlock({
      goal: false,
      delegated: false,
      usedTokens: 0,
      reservedTokens: 0,
      requestTokens: 100,
      tokenLimit: 99,
    }),
  ).toBe(true);
  expect(
    brokerRootTokensBlock({
      goal: true,
      delegated: false,
      usedTokens: 20_000,
      reservedTokens: 120_000,
      requestTokens: 8_000,
      tokenLimit: 140_000,
    }),
  ).toBe(true);
  expect(
    brokerRootTokensBlock({
      goal: true,
      delegated: true,
      usedTokens: 200_000,
      reservedTokens: 30_000,
      requestTokens: 1_000,
      tokenLimit: 120_000,
    }),
  ).toBe(true);
});

it("uses the pinned run allowance only for a standalone coordinator, not goals or workers", () => {
  const base = {
    goal: false,
    delegated: false,
    usedTokens: 0,
    reservedTokens: 0,
    requestTokens: 121_891,
    tokenLimit: 120_000,
    coordinatorRunAllowance: 17_048_576,
  };
  expect(brokerRootTokensBlock(base)).toBe(false);
  expect(brokerRootTokensBlock({ ...base, tokenLimit: 100_000 })).toBe(true);
  expect(brokerRootTokensBlock({ ...base, goal: true })).toBe(true);
  expect(brokerRootTokensBlock({ ...base, delegated: true })).toBe(false);
  expect(
    brokerRootTokensBlock({ ...base, goal: true, delegated: true, reservedTokens: 120_001 }),
  ).toBe(true);
  expect(brokerRootTokensBlock({ ...base, usedTokens: base.coordinatorRunAllowance })).toBe(true);
  expect(brokerRootTokensBlock({ ...base, coordinatorRunAllowance: undefined })).toBe(true);
});

it("attributes the usage record and its event to the same run", async () => {
  const create = vi.fn(async () => ({ id: "usage" }));
  const append = vi.fn();
  const run = { id: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" };
  await recordRunUsage(
    { prisma: { usageRecord: { create } } as unknown as PrismaClient, events: { append } },
    run,
    { provider: "fixture", model: "fixture", inputTokens: 10, outputTokens: 20 },
  );
  expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ runId: run.id }) });
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({ purpose: "legacy", coverage: "partial" }),
  });
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "usage.recorded",
      runId: run.id,
      payload: expect.objectContaining({
        usageId: "usage",
        inputTokens: 10,
        outputTokens: 20,
        rootTaskId: null,
        requesterBotId: "bot",
        actingBotId: "bot",
        depth: 0,
        cost: null,
        pricingProvenance: null,
      }),
    }),
  );
});

it("marks unreported legacy totals as unknown instead of a measured zero", async () => {
  const create = vi.fn(async () => ({ id: "usage" }));
  await recordRunUsage(
    {
      prisma: { usageRecord: { create } } as unknown as PrismaClient,
      events: { append: vi.fn() },
    },
    { id: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" },
    {
      provider: "fixture",
      model: "fixture",
      inputTokens: 0,
      outputTokens: 0,
      reported: false,
    },
  );
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      inputTokens: 0,
      outputTokens: 0,
      categoryCoverage: {
        logicalInput: "unknown",
        uncachedInput: "unknown",
        cacheReadInput: "unknown",
        cacheWriteInput: "unknown",
        output: "unknown",
        reasoning: "unknown",
      },
    }),
  });
});

it.each(["running", "completed"])(
  "attributes helper usage and releases only live reservations (%s)",
  async (status) => {
    const row = {
      id: "helper",
      rootTaskId: "root",
      requesterBotId: "chief",
      actingBotId: "worker",
      depth: 1,
      status,
      runId: "run",
      reservedTokens: 100,
      usedTokens: 80,
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      delegation: { findUniqueOrThrow: vi.fn(async () => row), update: vi.fn() },
      delegationRoot: { update: vi.fn() },
      usageRecord: { create: vi.fn(async () => ({ id: "usage" })) },
      botMessageDelivery: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      ...tx,
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        fn(tx as unknown as Prisma.TransactionClient),
    } as unknown as PrismaClient;
    const append = vi.fn();
    await recordRunUsage(
      { prisma, events: { append } },
      {
        id: "run",
        spaceId: "space",
        userId: "owner",
        botId: "worker",
        threadId: "thread",
        delegationId: "helper",
      },
      { provider: "local", model: "fixture", inputTokens: 10, outputTokens: 20 },
    );
    const identity = {
      rootTaskId: "root",
      requesterBotId: "chief",
      actingBotId: "worker",
      depth: 1,
      delegationId: "helper",
      cost: null,
    };
    expect(tx.usageRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining(identity) });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ ...identity, pricingProvenance: null }),
      }),
    );
    expect(tx.delegationRoot.update).toHaveBeenCalledWith({
      where: { rootTaskId: "root" },
      data: {
        usedTokens: { increment: 30 },
        reservedTokens: { decrement: status === "running" ? 20 : 0 },
      },
    });
  },
);
it("charges coordinator usage to the existing root under the admission lock", async () => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    delegationRoot: { updateMany: vi.fn() },
    usageRecord: { create: vi.fn(async () => ({ id: "usage" })) },
    botMessageDelivery: { findMany: vi.fn(async () => []) },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaClient;
  await recordRunUsage(
    { prisma, events: { append: vi.fn() } },
    {
      id: "run",
      spaceId: "space",
      userId: "owner",
      botId: "chief",
      threadId: "thread",
      taskId: "root",
      delegationRootTaskId: "goal-root",
    },
    { provider: "fixture", model: "fixture", inputTokens: 10, outputTokens: 20 },
  );
  expect(tx.$queryRaw).toHaveBeenCalledOnce();
  expect(tx.delegationRoot.updateMany).toHaveBeenCalledWith({
    where: { rootTaskId: "goal-root" },
    data: { usedTokens: { increment: 30 } },
  });
  expect(tx.usageRecord.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ rootTaskId: "goal-root" }),
  });
});

const standaloneScope = {
  spaceId: "space",
  userId: "user",
  botId: "bot",
  threadId: "judge-thread",
  purpose: "helper" as const,
  runtimePin: { runtimeKind: "pi", provider: "fixture", modelId: "fixture" },
};
/** In-memory ledger mirroring production semantics: updates address rows by id
 *  (no request key in update data) and observation receipts persist per
 *  (usageRecordId, sequence), so replay dedup is actually exercised. */
function standalonePrisma() {
  let nextId = 0;
  const rows = new Map<string, Record<string, unknown>>();
  const byRequestKey = new Map<string, string>();
  const receipts = new Map<string, Record<string, unknown>>();
  const tx = {
    usageRecord: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; requestKey?: string } }) => {
        const id = where.id ?? (where.requestKey ? byRequestKey.get(where.requestKey) : undefined);
        const row = id ? rows.get(id) : undefined;
        return row ? structuredClone(row) : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `usage-${++nextId}`;
        const row = { ...data, id };
        rows.set(id, row);
        if (data.requestKey) byRequestKey.set(data.requestKey as string, id);
        return structuredClone(row);
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.get(where.id);
          if (!row) throw new Error(`usage row ${where.id} not found`);
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
          const key = `${where.usageRecordId_sequence.usageRecordId}:${where.usageRecordId_sequence.sequence}`;
          const receipt = receipts.get(key);
          return receipt ? structuredClone(receipt) : null;
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: { usageRecordId: string; sequence: number } & Record<string, unknown>;
        }) => {
          const key = `${data.usageRecordId}:${data.sequence}`;
          receipts.set(key, { ...data });
          return { id: `receipt-${key}` };
        },
      ),
    },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaClient;
  return { prisma, rows, receipts };
}
const collector = () =>
  new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
const storedRow = (rows: Map<string, Record<string, unknown>>) => {
  expect(rows.size).toBe(1);
  return [...rows.values()][0]!;
};
it("records standalone usage with purpose, runtime pin, request identity and cache categories", async () => {
  const { prisma, rows, receipts } = standalonePrisma();
  const request = collector();
  for (const event of [
    request.start(),
    request.snapshot({ input: 100, output: 30, cacheRead: 60, cacheWrite: 10, reasoning: 5 }),
    request.finish("success"),
  ] as AgentUsage[])
    await recordStandaloneUsage({ prisma }, standaloneScope, event);
  expect(storedRow(rows)).toMatchObject({
    runId: null,
    purpose: "helper",
    threadId: "judge-thread",
    runtimePin: standaloneScope.runtimePin,
    inputTokens: 100,
    outputTokens: 30,
    logicalInputTokens: 100,
    cacheReadInputTokens: 60,
    cacheWriteInputTokens: 10,
    uncachedInputTokens: 30,
    reasoningTokens: 5,
    coverage: "complete",
  });
  expect(receipts.size).toBe(3);
});

it("keeps unreported standalone usage explicit instead of writing measured zeros", async () => {
  const { prisma, rows } = standalonePrisma();
  const request = collector();
  for (const event of [request.start(), request.finish("failed")] as AgentUsage[])
    await recordStandaloneUsage({ prisma }, standaloneScope, event);
  expect(storedRow(rows)).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
    logicalInputTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    reportedOutputTokens: null,
    coverage: "partial",
    categoryCoverage: {
      logicalInput: "unknown",
      uncachedInput: "unknown",
      cacheReadInput: "unknown",
      cacheWriteInput: "unknown",
      output: "unknown",
      reasoning: "unknown",
    },
  });
});

it("stores identity-free standalone totals as legacy rows, marking unreported ones unknown", async () => {
  const { prisma, rows } = standalonePrisma();
  const usage = { provider: "fixture", model: "fixture", inputTokens: 100, outputTokens: 30 };
  await recordStandaloneUsage({ prisma }, standaloneScope, usage);
  await recordStandaloneUsage({ prisma }, standaloneScope, {
    ...usage,
    inputTokens: 0,
    outputTokens: 0,
    reported: false,
  });
  const [measured, unreported] = [...rows.values()];
  // The same fields the run path's legacy writer stores, plus the run-less scope.
  expect(measured).toMatchObject({
    purpose: "legacy",
    coverage: "partial",
    threadId: "judge-thread",
    runId: null,
    runtimePin: standaloneScope.runtimePin,
    inputTokens: 100,
    outputTokens: 30,
  });
  expect(measured).not.toHaveProperty("categoryCoverage");
  expect(unreported).toMatchObject({
    purpose: "legacy",
    categoryCoverage: {
      logicalInput: "unknown",
      uncachedInput: "unknown",
      cacheReadInput: "unknown",
      cacheWriteInput: "unknown",
      output: "unknown",
      reasoning: "unknown",
    },
  });
});

it("refuses a broker admission on a run-less request", async () => {
  const { prisma, rows } = standalonePrisma();
  const event = collector().snapshot({ input: 100, output: 30 }) as AgentUsage;
  event.request!.admission = {
    kind: "worker-provider-broker",
    reservedTokens: 10,
    maxRequests: 1,
    maxReservedTokens: 10,
  };
  await expect(recordStandaloneUsage({ prisma }, standaloneScope, event)).rejects.toThrow(
    "Run-less usage cannot carry a broker admission",
  );
  expect(rows.size).toBe(0);
});

it("retries a standalone write that hit a serialization conflict", async () => {
  const { prisma, rows } = standalonePrisma();
  const run = prisma.$transaction.bind(prisma);
  const transaction = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error("serialization failure"), { code: "P2034" }))
    .mockImplementation(run);
  const retrying = { ...prisma, $transaction: transaction } as unknown as PrismaClient;
  await recordStandaloneUsage(
    { prisma: retrying },
    standaloneScope,
    collector().snapshot({ input: 100, output: 30 }) as AgentUsage,
  );
  expect(transaction).toHaveBeenCalledTimes(2);
  expect(storedRow(rows)).toMatchObject({ inputTokens: 100, outputTokens: 30 });
});

it("counts a replayed duplicate snapshot once in the stored row", async () => {
  const { prisma, rows, receipts } = standalonePrisma();
  const request = collector();
  const started = request.start();
  const snapshot = request.snapshot({ input: 100, output: 30 });
  for (const event of [started, snapshot, snapshot, request.finish("success")] as AgentUsage[])
    await recordStandaloneUsage({ prisma }, standaloneScope, event);
  expect(storedRow(rows)).toMatchObject({ inputTokens: 100, outputTokens: 30 });
  // start, snapshot, finish — the replayed snapshot stored no extra receipt.
  expect(receipts.size).toBe(3);
});

it("stores a distinct retry attempt as its own row with its own totals", async () => {
  const { prisma, rows } = standalonePrisma();
  const first = new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    requestId: "judge-request",
    attemptId: "first",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
  const retry = new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    requestId: "judge-request",
    attemptId: "retry",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
  for (const event of [
    first.start(),
    first.snapshot({ input: 100, output: 30 }),
    first.finish("failed"),
    retry.start(),
    retry.snapshot({ input: 20, output: 8 }),
    retry.finish("success"),
  ] as AgentUsage[])
    await recordStandaloneUsage({ prisma }, standaloneScope, event);
  expect(rows.size).toBe(2);
  const [a, b] = [...rows.values()];
  expect(a).toMatchObject({ attemptId: "first", inputTokens: 100, outputTokens: 30 });
  expect(b).toMatchObject({ attemptId: "retry", inputTokens: 20, outputTokens: 8 });
});

it("accumulates stored delta observations into the row totals", async () => {
  const { prisma, rows } = standalonePrisma();
  const delta = (
    sequence: number,
    input: number,
    output: number,
    outcome: "started" | "success" = "started",
  ): AgentUsage => ({
    provider: "fixture",
    model: "fixture",
    inputTokens: input,
    outputTokens: output,
    request: {
      requestId: "delta-request",
      attemptId: "0",
      parentRequestId: null,
      purpose: "helper",
      counter: { mode: "delta", epochId: "0", sequence },
      inputSemantics: "total-with-cache-subsets",
      reasoningSemantics: "subset-of-output",
      categories: {
        logicalInput: input,
        uncachedInput: null,
        cacheReadInput: null,
        cacheWriteInput: null,
        output,
        reasoning: null,
      },
      cost: null,
      pricingProvenance: null,
      collection: {
        mappingVersion: "fixture-v1",
        scope: "runtime-call",
        outcome,
        availability: "partial",
        raw: {},
        limitations: [],
      },
    },
  });
  for (const event of [delta(0, 100, 30), delta(1, 40, 10), delta(2, 0, 0, "success")])
    await recordStandaloneUsage({ prisma }, standaloneScope, event);
  expect(storedRow(rows)).toMatchObject({ inputTokens: 140, outputTokens: 40 });
});

it("stores the usage pin, not the source run's pin, when a reviewer pin is supplied", async () => {
  const create = vi.fn(async () => ({ id: "usage" }));
  const runRow = {
    id: "run",
    spaceId: "space",
    userId: "user",
    botId: "bot",
    threadId: "thread",
    taskId: "root",
    delegationRootTaskId: null,
    delegationId: null,
    status: "completed",
    runtimePin: { runtimeKind: "pi", provider: "anthropic", modelId: "claude-opus" },
    createdAt: new Date(),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findUniqueOrThrow: vi.fn(async () => structuredClone(runRow)),
      findUnique: vi.fn(async () => structuredClone(runRow)),
    },
    delegation: { findUniqueOrThrow: vi.fn() },
    usageRecord: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create,
    },
    requestUsageObservation: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "receipt" })),
    },
    task: { findFirst: vi.fn(async () => ({ id: "root" })) },
    delegationRoot: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    botMessageDelivery: { findMany: vi.fn(async () => []), update: vi.fn() },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
    event: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: "event" })) },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaClient;
  const reviewerPin = {
    runtimeKind: "codex-app-server" as const,
    provider: "openai-codex",
    modelId: "gpt-6-astra",
    effort: "high",
    credentialId: "native:codex-app-server",
    revision: 1,
  };
  const collector = new RequestUsageCollector({
    provider: "openai-codex",
    model: "gpt-6-astra",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
  await recordRunUsage(
    { prisma, events: { append: vi.fn() } },
    {
      id: "run",
      spaceId: "space",
      userId: "user",
      botId: "bot",
      threadId: "thread",
      taskId: "root",
    },
    collector.snapshot({ input: 100, output: 30 }),
    reviewerPin,
  );
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      provider: "openai-codex",
      model: "gpt-6-astra",
      runtimePin: reviewerPin,
      runId: "run",
    }),
  });
});
