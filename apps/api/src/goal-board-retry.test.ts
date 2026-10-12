import { createLogger, createTestSink, installLogger } from "@ardurbot/logging";
import { afterEach, expect, it, vi } from "vitest";
import { goalBoardDeliveryRetry } from "./goal-board.js";

afterEach(() => {
  installLogger(createLogger({ service: "ardurbot-api", level: "off", sinks: [] }));
});

it("keeps the scheduler alive when the outbox query fails", async () => {
  const secret = "postgres://owner:secret-token@db.internal/ardur";
  const sink = createTestSink();
  installLogger(createLogger({ service: "ardurbot-api", sinks: [sink] }));
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  let queries = 0;
  const updateMany = vi.fn();
  const prisma = {
    goalBoardDelivery: {
      findMany: async () => {
        queries += 1;
        if (queries === 1) throw new Error(secret);
        return [];
      },
      updateMany,
    },
  };
  const scheduler = goalBoardDeliveryRetry(
    { prisma: prisma as never, dataDir: "/fixture" },
    { ARDURBOT_HOST_BRIDGE: "api" },
  );
  expect(scheduler).toBeDefined();
  try {
    scheduler!.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.events)).not.toContain("secret-token");
    expect(sink.events.some((event) => event.message === "goal board delivery sweep failed")).toBe(
      true,
    );
    await scheduler!.stop();
    scheduler!.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler!.stop();
    expect(queries).toBe(2);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
    await scheduler?.stop();
  }
});
