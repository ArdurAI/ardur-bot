import type { PrismaClient } from "@ardurbot/db";
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
      payload: { usageId: "usage", inputTokens: 10, outputTokens: 20 },
    }),
  );
});
