import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBotPresence } from "./bot-presence.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("bot presence activity query (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("selects the newest eligible message per bot and keeps bots without messages", async () => {
    // Two separate people, each with their own space, bot and thread, so the scope filter is real.
    const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
    const mine = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: "+15550002221" },
      signup,
    );
    const other = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: "+15550002222" },
      signup,
    );
    const active = await db.prisma.bot.findUniqueOrThrow({ where: { id: mine.botId } });
    const quiet = await db.prisma.bot.create({
      data: {
        spaceId: mine.spaceId,
        userId: mine.userId,
        name: "Quiet bot",
        color: active.color,
      },
    });

    const message = (id: string, threadId: string, role: string, seq: number, at: string) =>
      db.prisma.message.create({
        data: {
          id,
          threadId,
          botId: active.id,
          role,
          seq,
          blocks: [],
          createdAt: new Date(at),
        },
      });
    await message("presence-older", mine.threadId, "bot", 101, "2026-09-01T10:00:00Z");
    const expected = new Date("2026-09-02T10:00:00Z");
    await message("presence-newest-bot", mine.threadId, "bot", 102, expected.toISOString());
    // Newer, but not the bot speaking.
    await message("presence-user", mine.threadId, "user", 103, "2026-09-03T10:00:00Z");
    // Newer, but in a thread outside this person's scope.
    await message("presence-other-thread", other.threadId, "bot", 101, "2026-09-04T10:00:00Z");

    const result = await loadBotPresence(db.prisma, {
      spaceId: mine.spaceId,
      userId: mine.userId,
    });

    expect(result.bots.find((bot) => bot.botId === active.id)?.lastActiveAt).toBe(
      expected.toISOString(),
    );
    const quietPresence = result.bots.find((bot) => bot.botId === quiet.id);
    expect(quietPresence).toBeDefined();
    expect(quietPresence?.lastActiveAt).toBeUndefined();
    expect(result.bots.some((bot) => bot.botId === other.botId)).toBe(false);
  });

  it("reads one newest message per bot, scoped by space and by user independently", async () => {
    const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
    const mine = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: "+15550002223" },
      signup,
    );
    const other = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: "+15550002224" },
      signup,
    );
    // Each excluded thread differs from the scope in only one way, so each filter is needed.
    // A thread needs exactly one owner, so each gets its own helper bot.
    const { color } = await db.prisma.bot.findUniqueOrThrow({ where: { id: mine.botId } });
    const threadFor = async (spaceId: string, userId: string) => {
      const owner = await db.prisma.bot.create({
        data: { spaceId, userId, name: "Helper", color },
      });
      return db.prisma.thread.create({ data: { spaceId, userId, botId: owner.id } });
    };
    const sameSpaceOtherUser = await threadFor(mine.spaceId, other.userId);
    const sameUserOtherSpace = await threadFor(other.spaceId, mine.userId);
    const message = (id: string, threadId: string, seq: number, at: string) =>
      db.prisma.message.create({
        data: {
          id,
          threadId,
          botId: mine.botId,
          role: "bot",
          seq,
          blocks: [],
          createdAt: new Date(at),
        },
      });
    // The older row is inserted first, so a scan without ORDER BY would return it.
    await message("strict-older", mine.threadId, 201, "2026-09-10T10:00:00Z");
    const expected = new Date("2026-09-11T10:00:00Z");
    await message("strict-newest", mine.threadId, 202, expected.toISOString());
    await message("strict-other-user", sameSpaceOtherUser.id, 1, "2026-09-12T10:00:00Z");
    await message("strict-other-space", sameUserOtherSpace.id, 1, "2026-09-13T10:00:00Z");

    const activity: { botId: string; createdAt: Date }[] = [];
    const result = await db.prisma.$transaction(async (tx) => {
      // Without index scans, only the query's own ORDER BY can return the newest row.
      await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_indexonlyscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      const recording = new Proxy(tx, {
        get(target, key, receiver) {
          if (key !== "$queryRaw") return Reflect.get(target, key, receiver);
          return async (...args: Parameters<typeof target.$queryRaw>) => {
            const rows = await target.$queryRaw(...args);
            if (Array.isArray(rows)) activity.push(...(rows as typeof activity));
            return rows;
          };
        },
      });
      return loadBotPresence(recording as unknown as PrismaClient, {
        spaceId: mine.spaceId,
        userId: mine.userId,
      });
    });

    // One row per bot: the query must never read a bot's whole message history.
    expect(activity.filter((row) => row.botId === mine.botId)).toHaveLength(1);
    expect(result.bots.find((bot) => bot.botId === mine.botId)?.lastActiveAt).toBe(
      expected.toISOString(),
    );
  });
});
