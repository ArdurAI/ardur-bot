import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { scheduleCompactionAfterTurn } from "../history-compaction.js";

it.each(["completed", "failed", "waiting_input"])(
  "immediately schedules the existing job after a %s turn crosses the threshold",
  async (status) => {
    const run = {
      status,
      comparisonId: null,
      thread: { id: "group-thread", nextMessageSeq: 100, historyCompactedUpToSeq: null },
    };
    const prisma = {
      run: { findUnique: async () => run, findMany: async () => [] },
      message: {
        count: async ({ where }: { where: { seq: { gt: number; lt: number } } }) =>
          Math.max(0, where.seq.lt - where.seq.gt - 1),
      },
    } as unknown as PrismaClient;
    const enqueue = vi.fn();
    await scheduleCompactionAfterTurn(prisma, { enqueue } as unknown as JobPublisher, "run");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "history.compact",
        payload: { threadId: "group-thread", sourceRunId: "run" },
      }),
    );
    enqueue.mockClear();
    run.thread.historyCompactedUpToSeq = 49 as never;
    await scheduleCompactionAfterTurn(prisma, { enqueue } as unknown as JobPublisher, "run");
    expect(enqueue).not.toHaveBeenCalled();
  },
);

it("does not schedule compaction when empty sequence numbers inflate the span", async () => {
  const run = {
    status: "completed",
    comparisonId: null,
    thread: { id: "group-thread", nextMessageSeq: 100, historyCompactedUpToSeq: null },
  };
  const prisma = {
    run: { findUnique: async () => run, findMany: async () => [] },
    message: { count: async () => 10 },
  } as unknown as PrismaClient;
  const enqueue = vi.fn();
  await scheduleCompactionAfterTurn(prisma, { enqueue } as unknown as JobPublisher, "run");
  expect(enqueue).not.toHaveBeenCalled();
});

it("does not count messages at or above a place a running reply still holds", async () => {
  const run = {
    status: "completed",
    comparisonId: null,
    thread: { id: "group-thread", nextMessageSeq: 200, historyCompactedUpToSeq: null },
  };
  const prisma = {
    run: { findUnique: async () => run, findMany: async () => [{ replySeq: 10 }] },
    message: {
      count: async ({ where }: { where: { seq: { gt: number; lt: number } } }) =>
        Math.max(0, where.seq.lt - where.seq.gt - 1),
    },
  } as unknown as PrismaClient;
  const enqueue = vi.fn();
  await scheduleCompactionAfterTurn(prisma, { enqueue } as unknown as JobPublisher, "run");
  expect(enqueue).not.toHaveBeenCalled();
});
