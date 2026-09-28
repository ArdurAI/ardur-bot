import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { loadBotPresence } from "./bot-presence.js";

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
    const spaceId = "space-presence-1";
    const userId = "user-presence-1";
    const scope = { spaceId, userId };
    const color = "yellow";

    // Create two bots
    const bot1 = await db.prisma.bot.create({
      data: { id: "bot-1", spaceId, userId, name: "Bot 1", color },
    });
    const bot2 = await db.prisma.bot.create({
      data: { id: "bot-no-msgs", spaceId, userId, name: "Bot 2", color },
    });
    const bot3 = await db.prisma.bot.create({
      data: { id: "bot-other-space", spaceId: "space-other", userId, name: "Bot 3", color },
    });

    // Create threads
    const thread1 = await db.prisma.thread.create({
      data: { id: "thread-1", spaceId, userId },
    });
    const threadOther = await db.prisma.thread.create({
      data: { id: "thread-other", spaceId: "space-other", userId },
    });

    // Insert messages for Bot 1
    // 1. Older bot message
    await db.prisma.message.create({
      data: {
        id: "msg-1",
        threadId: thread1.id,
        botId: bot1.id,
        role: "bot",
        seq: 1,
        blocks: [],
        createdAt: new Date("2026-09-01T10:00:00Z"),
      },
    });
    // 2. Newer bot message (this should be selected)
    const expectedTime = new Date("2026-09-02T10:00:00Z");
    await db.prisma.message.create({
      data: {
        id: "msg-2",
        threadId: thread1.id,
        botId: bot1.id,
        role: "bot",
        seq: 2,
        blocks: [],
        createdAt: expectedTime,
      },
    });
    // 3. Even newer but non-bot message (e.g. user message)
    await db.prisma.message.create({
      data: {
        id: "msg-3",
        threadId: thread1.id,
        botId: bot1.id,
        role: "user",
        seq: 3,
        blocks: [],
        createdAt: new Date("2026-09-03T10:00:00Z"),
      },
    });
    // 4. Even newer bot message but in an excluded thread scope
    await db.prisma.message.create({
      data: {
        id: "msg-4",
        threadId: threadOther.id,
        botId: bot1.id,
        role: "bot",
        seq: 1,
        blocks: [],
        createdAt: new Date("2026-09-04T10:00:00Z"),
      },
    });

    const result = await loadBotPresence(db.prisma, scope);

    // Sort by id for deterministic assertion
    const bots = result.bots.sort((a, b) => a.botId.localeCompare(b.botId));

    // Bot 1 should have the timestamp of msg-2
    const bot1Presence = bots.find((b) => b.botId === bot1.id);
    expect(bot1Presence).toBeDefined();
    expect(bot1Presence?.lastActiveAt).toBe(expectedTime.toISOString());

    // Bot 2 has no messages, should still be in the directory
    const bot2Presence = bots.find((b) => b.botId === bot2.id);
    expect(bot2Presence).toBeDefined();
    expect(bot2Presence?.lastActiveAt).toBeUndefined();

    // Bot 3 should not be in the directory (different space)
    const bot3Presence = bots.find((b) => b.botId === bot3.id);
    expect(bot3Presence).toBeUndefined();
  });
});
