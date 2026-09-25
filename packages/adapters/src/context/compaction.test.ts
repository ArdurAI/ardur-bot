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
    const prisma = { run: { findUnique: async () => run } } as unknown as PrismaClient;
    const enqueue = vi.fn();
    await scheduleCompactionAfterTurn(prisma, { enqueue } as unknown as JobPublisher, "run");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "history.compact", payload: { threadId: "group-thread" } }),
    );
    enqueue.mockClear();
    run.thread.historyCompactedUpToSeq = 49 as never;
    await scheduleCompactionAfterTurn(prisma, { enqueue } as unknown as JobPublisher, "run");
    expect(enqueue).not.toHaveBeenCalled();
  },
);
