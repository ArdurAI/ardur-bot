import type { PrismaClient } from "@ardurbot/db";
import { expect, it } from "vitest";
import { claimBotRun } from "./concurrency.js";

it("shares a bot cap across workers, queues the excess and serializes threads", async () => {
  let tail: Promise<unknown> = Promise.resolve();
  const active: Array<{ id: string; botId: string; threadId: string }> = [];
  const maintenance: Array<{ botId: string; threadId: string }> = [];
  const tx = {
    $queryRaw: async () => [],
    bot: {
      findUniqueOrThrow: async () => ({ concurrentRuns: null, space: { concurrentRuns: 3 } }),
    },
    botBrief: {
      count: async ({ where }: { where: { botId?: string; threadId?: string } }) =>
        maintenance.filter(
          (brief) =>
            (!where.botId || brief.botId === where.botId) &&
            (!where.threadId || brief.threadId === where.threadId),
        ).length,
    },
    run: {
      count: async ({
        where,
      }: {
        where: { id: { not: string }; botId?: string; threadId?: string };
      }) =>
        active.filter(
          (run) =>
            run.id !== where.id.not &&
            (!where.botId || run.botId === where.botId) &&
            (!where.threadId || run.threadId === where.threadId),
        ).length,
    },
  };
  const prisma = {
    $transaction: (action: (tx: unknown) => Promise<unknown>) => {
      const result = tail.then(() => action(tx));
      tail = result.catch(() => undefined);
      return result;
    },
  } as unknown as PrismaClient;
  const claim = (id: string, threadId = id, botId = "chief") =>
    claimBotRun(prisma, {
      runId: id,
      botId,
      threadId,
      now: new Date(),
      claim: async () => {
        active.push({ id, botId, threadId });
        return { count: 1 };
      },
    });
  const results = await Promise.all([claim("one"), claim("two"), claim("three"), claim("four")]);
  expect(results.map((result) => result.count)).toEqual([1, 1, 1, 0]);
  expect(results[3]?.queued).toBe(true);
  expect((await claim("peer", "one", "worker")).queued).toBe(true);
  expect((await claim("other", "other", "worker")).count).toBe(1);
  active.shift();
  expect((await claim("four")).count).toBe(1);
  active.length = 0;
  maintenance.push({ botId: "chief", threadId: "maintained" });
  expect((await claim("peer", "maintained", "worker")).queued).toBe(true);
  expect((await claim("one")).count).toBe(1);
  expect((await claim("two")).count).toBe(1);
  expect((await claim("three")).queued).toBe(true);
});
