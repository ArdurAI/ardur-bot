import type { PrismaClient } from "@ardurbot/db";
import { expect, it } from "vitest";
import { claimBotRun } from "./concurrency.js";

type ActiveRun = { id: string; botId: string; threadId: string };
type BriefLease = { botId: string; threadId: string };

/**
 * In-memory admission fixture. Transactions run one at a time, as the bot and thread
 * row locks serialize them in Postgres. Threads optionally point at a group whose
 * stored policy sets how many runs the room admits at once.
 */
function admissionFixture(options?: {
  botCap?: number;
  groups?: Record<string, { policy: unknown }>;
  threadGroups?: Record<string, string>;
}) {
  const botCap = options?.botCap ?? 3;
  const groups = options?.groups ?? {};
  const threadGroups = options?.threadGroups ?? {};
  const active: ActiveRun[] = [];
  const maintenance: BriefLease[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const tx = {
    $queryRaw: async () => [],
    bot: {
      findUniqueOrThrow: async () => ({
        concurrentRuns: null,
        space: { concurrentRuns: botCap },
      }),
    },
    thread: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const groupId = threadGroups[where.id] ?? null;
        return { groupId, group: groupId ? { policy: groups[groupId]?.policy } : null };
      },
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
    $transaction: (action: (txArg: unknown) => Promise<unknown>) => {
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
  return { active, maintenance, claim };
}

it("shares a bot cap across workers and queues the excess", async () => {
  const { active, claim } = admissionFixture({ botCap: 3 });
  const results = await Promise.all([claim("one"), claim("two"), claim("three"), claim("four")]);
  expect(results.map((result) => result.count)).toEqual([1, 1, 1, 0]);
  expect(results[3]?.queued).toBe(true);
  active.shift();
  expect((await claim("four")).count).toBe(1);
});

it("admits a group room's bots together up to the policy, and queues the next one", async () => {
  const { active, claim } = admissionFixture({
    botCap: 8,
    groups: { room: { policy: { version: 1, maxConcurrentRuns: 4 } } },
    threadGroups: { room: "room" },
  });
  const results = await Promise.all([
    claim("one", "room", "ada"),
    claim("two", "room", "beck"),
    claim("three", "room", "cy"),
    claim("four", "room", "dora"),
  ]);
  expect(results.map((result) => result.count)).toEqual([1, 1, 1, 1]);
  // A fifth bot waits for a free place in the room.
  expect((await claim("five", "room", "eli")).queued).toBe(true);
  // A second run of an admitted bot in the same thread waits too.
  expect((await claim("six", "room", "ada")).queued).toBe(true);
  // The fifth bot is admitted as soon as a place frees.
  active.shift();
  expect((await claim("five", "room", "eli")).count).toBe(1);
  // A bot already working in the room can still run in another thread.
  expect((await claim("seven", "elsewhere", "ada")).count).toBe(1);
});

it("reads the defaults for a room without a stored policy", async () => {
  const { claim } = admissionFixture({
    botCap: 8,
    groups: { room: { policy: null } },
    threadGroups: { room: "room" },
  });
  const results = await Promise.all([
    claim("one", "room", "ada"),
    claim("two", "room", "beck"),
    claim("three", "room", "cy"),
    claim("four", "room", "dora"),
    claim("five", "room", "eli"),
  ]);
  expect(results.map((result) => result.count)).toEqual([1, 1, 1, 1, 0]);
});

it("keeps the old one-at-a-time behaviour when the room policy is 1", async () => {
  const { active, claim } = admissionFixture({
    botCap: 8,
    groups: { room: { policy: { version: 1, maxConcurrentRuns: 1 } } },
    threadGroups: { room: "room" },
  });
  expect((await claim("one", "room", "ada")).count).toBe(1);
  expect((await claim("two", "room", "beck")).queued).toBe(true);
  active.shift();
  expect((await claim("two", "room", "beck")).count).toBe(1);
});

it("admits one run in a direct thread", async () => {
  const { active, claim } = admissionFixture({ botCap: 8 });
  expect((await claim("one", "direct", "ada")).count).toBe(1);
  expect((await claim("two", "direct", "ada")).queued).toBe(true);
  active.shift();
  expect((await claim("two", "direct", "ada")).count).toBe(1);
});

it("waits only for the same bot's brief, never another bot's", async () => {
  const { maintenance, claim } = admissionFixture({
    botCap: 8,
    groups: { room: { policy: { version: 1, maxConcurrentRuns: 4 } } },
    threadGroups: { room: "room" },
  });
  maintenance.push({ botId: "ada", threadId: "room" });
  // Ada's own after-run brief holds her next run in the room…
  expect((await claim("one", "room", "ada")).queued).toBe(true);
  // …but no one else's.
  expect((await claim("two", "room", "beck")).count).toBe(1);
  maintenance.length = 0;
  expect((await claim("one", "room", "ada")).count).toBe(1);
});
