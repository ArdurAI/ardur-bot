import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBotPresence } from "./bot-presence.js";
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
});
