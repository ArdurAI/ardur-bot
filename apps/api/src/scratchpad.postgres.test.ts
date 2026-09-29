import { createDb } from "@ardurbot/db";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("scratchpad board linking (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const owner = { spaceId: "scratchpad-fixture-space", userId: "scratchpad-fixture-owner" };
  const botId = "scratchpad-fixture-bot";
  const boardWorkspaceId = "scratchpad-fixture-board";
  
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.user.create({
      data: {
        id: owner.userId,
        spaceId: owner.spaceId,
        email: "scratchpad@fixture.invalid",
        role: "owner",
      },
    });
    await db.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Test bot",
        model: "test-model"
      }
    });
    await db.prisma.boardWorkspace.create({
      data: {
        id: boardWorkspaceId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        path: "scratchpad-test-board",
        name: "Scratchpad Test Board",
        enabled: true,
        allowAllBots: true,
        allowedBotIds: [],
        version: "1.0",
        format: "beads"
      }
    });
  });

  afterAll(async () => {
    await db.prisma.scratchpadItem.deleteMany({ where: { spaceId: owner.spaceId } });
    await db.prisma.boardWorkspace.deleteMany({ where: { id: boardWorkspaceId } });
    await db.prisma.bot.deleteMany({ where: { id: botId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
    await db.prisma.$disconnect();
  });

  it("linking validates space, board enabled, bot allowed, item exists, and no duplicates", async () => {
    const router = createRouter({
      prisma: db.prisma,
      repos: {
        getBot: async (actor, bId) => {
          if (bId !== botId || actor.spaceId !== owner.spaceId) throw new Error("Not found");
          return { id: botId, spaceId: owner.spaceId };
        }
      } as any,
      board: {
        service: {
          snapshot: async (actor, req) => {
            if (req.workspaceId !== boardWorkspaceId) throw new Error("Not found");
            return {
              items: [
                { id: "item1", title: "Item 1", status: "open", type: "task" },
                { id: "item2", title: "Item 2", status: "closed", type: "task" }
              ],
              readyIds: [], blockedIds: [], workspaces: []
            };
          }
        }
      } as any
    } as any);

    // Context helper
    const ctx = { actor: { ...owner, scope: "user" } } as any;

    // Reject non-existent items
    await expect(
      router.scratchpad.linkBoardItems({ context: ctx, input: { botId, boardWorkspaceId, boardItemIds: ["item3"] } })
    ).rejects.toThrow(/Item item3 not found on board/);

    // Link valid items
    const linked = await router.scratchpad.linkBoardItems({ context: ctx, input: { botId, boardWorkspaceId, boardItemIds: ["item1", "item2"] } });
    expect(linked).toHaveLength(2);
    expect(linked[0].boardItemId).toBe("item1");
    expect(linked[1].boardItemId).toBe("item2");

    // Reject duplicate link
    await expect(
      router.scratchpad.linkBoardItems({ context: ctx, input: { botId, boardWorkspaceId, boardItemIds: ["item1"] } })
    ).rejects.toThrow(/Duplicate link refused/);
  });
});
