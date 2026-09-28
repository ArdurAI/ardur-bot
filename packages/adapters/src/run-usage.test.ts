import type { AgentUsage } from "@ardurbot/adapter-kit";
import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { recordRunUsage, recordStandaloneUsage } from "./run-usage.js";

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
function standalonePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  const tx = {
    usageRecord: {
      findUnique: vi.fn(async ({ where }: { where: { requestKey: string } }) => {
        const row = rows.get(where.requestKey);
        return row ? structuredClone(row) : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.set(data.requestKey as string, { id: "standalone", ...data });
        return { id: "standalone", ...data };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = data.requestKey as string;
        rows.set(key, { ...rows.get(key), ...data });
        return { id: "standalone", ...data };
      }),
    },
    requestUsageObservation: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "receipt" })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaClient;
  return { prisma, tx };
}
it("records standalone usage with purpose, runtime pin, request identity and cache categories", async () => {
  const { prisma, tx } = standalonePrisma();
  const collector = new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
  for (const event of [
    collector.start(),
    collector.snapshot({ input: 100, output: 30, cacheRead: 60, cacheWrite: 10, reasoning: 5 }),
    collector.finish("success"),
  ] as AgentUsage[])
    await recordStandaloneUsage({ prisma }, standaloneScope, event);
  expect(tx.usageRecord.create).toHaveBeenCalledTimes(1);
  expect(tx.usageRecord.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      runId: null,
      purpose: "helper",
      threadId: "judge-thread",
      runtimePin: standaloneScope.runtimePin,
      requestId: expect.any(String),
      attemptId: expect.any(String),
    }),
  });
  expect(tx.usageRecord.update).toHaveBeenCalledTimes(2);
  expect(tx.usageRecord.update).toHaveBeenLastCalledWith({
    where: { id: "standalone" },
    data: expect.objectContaining({
      inputTokens: 100,
      outputTokens: 30,
      logicalInputTokens: 100,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 10,
      uncachedInputTokens: 30,
      reasoningTokens: 5,
      coverage: "complete",
    }),
  });
  expect(tx.requestUsageObservation.create).toHaveBeenCalledTimes(3);
});

it("keeps unreported standalone usage explicit instead of writing measured zeros", async () => {
  const { prisma, tx } = standalonePrisma();
  const collector = new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
  for (const event of [collector.start(), collector.finish("failed")] as AgentUsage[])
    await recordStandaloneUsage({ prisma }, standaloneScope, event);
  expect(tx.usageRecord.create).toHaveBeenCalledTimes(1);
  expect(tx.usageRecord.update).toHaveBeenCalledTimes(1);
  expect(tx.usageRecord.update).toHaveBeenLastCalledWith({
    where: { id: "standalone" },
    data: expect.objectContaining({
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
    }),
  });
});

it("preserves identity-free legacy deltas as standalone rows without a zero claim", async () => {
  const { prisma, tx } = standalonePrisma();
  const usage = { provider: "fixture", model: "fixture", inputTokens: 100, outputTokens: 30 };
  await recordStandaloneUsage({ prisma }, standaloneScope, usage);
  await recordStandaloneUsage({ prisma }, standaloneScope, { ...usage, reported: false });
  expect(tx.usageRecord.create).toHaveBeenCalledTimes(1);
  expect(tx.usageRecord.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      purpose: "helper",
      inputTokens: 100,
      outputTokens: 30,
      coverage: "partial",
    }),
  });
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
