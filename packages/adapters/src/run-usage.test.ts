import type { Prisma, PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { recordRunUsage } from "./run-usage.js";

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
      reservedTokens: 100,
      usedTokens: 80,
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      delegation: { findUniqueOrThrow: vi.fn(async () => row), update: vi.fn() },
      delegationRoot: { update: vi.fn() },
      usageRecord: { create: vi.fn(async () => ({ id: "usage" })) },
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
    },
    { provider: "fixture", model: "fixture", inputTokens: 10, outputTokens: 20 },
  );
  expect(tx.$queryRaw).toHaveBeenCalledOnce();
  expect(tx.delegationRoot.updateMany).toHaveBeenCalledWith({
    where: { rootTaskId: "root" },
    data: { usedTokens: { increment: 30 } },
  });
});
