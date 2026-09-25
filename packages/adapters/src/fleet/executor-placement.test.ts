import { expect, it, vi } from "vitest";
import { createRunExecutor } from "../executor.js";

// Admission has its own concurrency tests; these fixtures isolate placement before computer work.
vi.mock("../context/concurrency.js", () => ({
  claimBotRun: (prisma: unknown, input: { claim: (tx: unknown) => Promise<unknown> }) =>
    input.claim(prisma),
}));

function fixture(cancelled = false) {
  const run = {
    createdAt: new Date("2026-09-24T00:00:00Z"),
    id: "run",
    botId: "bot",
    userId: "owner",
    spaceId: "space",
    threadId: "thread",
    taskId: "task",
    status: "queued",
    leaseFence: 0,
    startedAt: null,
    runtimeComputer: null,
    cancelRequestedAt: null,
  };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased", leaseFence: 1 })),
      updateMany: vi
        .fn()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValue({ count: cancelled ? 0 : 1 }),
    },
    bot: { findUniqueOrThrow: vi.fn() },
    attempt: { create: vi.fn(async () => ({ id: "attempt" })) },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const placement = vi.fn(async () => {
    throw new Error("private-provider-detail");
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    placement,
    events: { finalizeRun },
    runtimeRegistry: {},
    web: {},
    browser: {},
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { prisma, placement, finalizeRun, executor };
}

it("finalizes a placement error through the normal task/event boundary before tools start", async () => {
  const f = fixture();
  await f.executor.continueRun("run", "worker");
  expect(f.prisma.bot.findUniqueOrThrow).not.toHaveBeenCalled();
  expect(f.finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      taskId: "task",
      attemptId: "attempt",
      leaseFence: 1,
      error: "The computer could not move. Check Computers and retry.",
    }),
  );
  expect(JSON.stringify(f.finalizeRun.mock.calls)).not.toContain("private-provider-detail");
});

it("does not overwrite a cancellation or a newer execution fence during placement failure", async () => {
  const f = fixture(true);
  await f.executor.continueRun("run", "worker");
  expect(f.prisma.attempt.create).not.toHaveBeenCalled();
  expect(f.finalizeRun).not.toHaveBeenCalled();
  expect(f.prisma.bot.findUniqueOrThrow).not.toHaveBeenCalled();
});

it("stops before acquiring a computer when placement is waiting for consent", async () => {
  const f = fixture();
  f.placement.mockResolvedValueOnce(false as never);
  await f.executor.continueRun("run", "worker");
  expect(f.prisma.attempt.create).not.toHaveBeenCalled();
  expect(f.finalizeRun).not.toHaveBeenCalled();
  expect(f.prisma.bot.findUniqueOrThrow).not.toHaveBeenCalled();
});
