import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { assertRunEvidenceAccess } from "./thread-access.js";

const actor = { spaceId: "space-1", userId: "owner-1" };

function fixture(kind: "private" | "group" | "external" = "private") {
  const run = {
    id: "run-1",
    spaceId: actor.spaceId,
    botId: "bot-1",
    threadId: kind === "external" ? "external-thread" : "thread-1",
    thread: { groupId: kind === "group" ? "group-1" : null },
  };
  const db = {
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" }) as unknown) },
    run: { findFirst: vi.fn(async () => run as unknown) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } }) as unknown) },
    chatGroup: {
      findFirst: vi.fn(
        async () => ({ id: "group-1", thread: { id: "thread-1" }, members: [{}, {}] }) as unknown,
      ),
    },
    externalConversation: { findFirst: vi.fn(async () => ({ id: "conversation-1" }) as unknown) },
  };
  return { db, run, prisma: db as unknown as PrismaClient };
}

describe("shared run evidence access", () => {
  it.each(["private", "group", "external"] as const)(
    "resolves a visible %s thread",
    async (kind) => {
      const f = fixture(kind);
      await expect(assertRunEvidenceAccess(f.prisma, actor, f.run.id)).resolves.toEqual(f.run);
      expect(f.db.spaceMember.findUnique).toHaveBeenCalledWith({
        where: { spaceId_userId: actor },
      });
      expect(f.db.run.findFirst).toHaveBeenCalledWith({
        where: { id: f.run.id, spaceId: actor.spaceId },
        include: { thread: { select: { groupId: true } } },
      });
      if (kind === "group") {
        expect(f.db.chatGroup.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "group-1", ...actor, archivedAt: null },
            include: expect.objectContaining({
              members: expect.objectContaining({ where: { bot: { archivedAt: null } } }),
            }),
          }),
        );
        expect(f.db.bot.findFirst).not.toHaveBeenCalled();
      } else {
        expect(f.db.bot.findFirst).toHaveBeenCalledWith({
          where: { id: "bot-1", ...actor, archivedAt: null },
          include: { thread: true, computer: true },
        });
      }
      if (kind === "external") {
        expect(f.db.externalConversation.findFirst).toHaveBeenCalledWith({
          where: { botId: "bot-1", ...actor, thread: { id: "external-thread" } },
          select: { id: true },
        });
      }
    },
  );

  it("refuses a non-member before reading the run", async () => {
    const f = fixture();
    f.db.spaceMember.findUnique.mockResolvedValue(null);
    await expect(assertRunEvidenceAccess(f.prisma, actor, f.run.id)).rejects.toThrow(
      IsolationError,
    );
    expect(f.db.run.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a missing or foreign-space run before resolving a thread", async () => {
    const f = fixture();
    f.db.run.findFirst.mockResolvedValue(null);
    await expect(assertRunEvidenceAccess(f.prisma, actor, f.run.id)).rejects.toThrow(
      IsolationError,
    );
    expect(f.db.bot.findFirst).not.toHaveBeenCalled();
    expect(f.db.chatGroup.findFirst).not.toHaveBeenCalled();
  });

  it("refuses an inaccessible private bot thread", async () => {
    const f = fixture();
    f.db.bot.findFirst.mockResolvedValue(null);
    await expect(assertRunEvidenceAccess(f.prisma, actor, f.run.id)).rejects.toThrow(
      IsolationError,
    );
  });

  it("refuses an unowned external conversation", async () => {
    const f = fixture("external");
    f.db.externalConversation.findFirst.mockResolvedValue(null);
    await expect(assertRunEvidenceAccess(f.prisma, actor, f.run.id)).rejects.toThrow(
      IsolationError,
    );
  });

  it.each([
    null,
    { id: "group-1", thread: { id: "thread-1" }, members: [{}] },
    { id: "group-1", thread: { id: "other-thread" }, members: [{}, {}] },
  ])("refuses an inaccessible or mismatched group target %j", async (group) => {
    const f = fixture("group");
    f.db.chatGroup.findFirst.mockResolvedValue(group);
    await expect(assertRunEvidenceAccess(f.prisma, actor, f.run.id)).rejects.toThrow(
      IsolationError,
    );
  });
});
