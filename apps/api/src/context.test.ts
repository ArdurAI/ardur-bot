import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { expect, it, vi } from "vitest";
import { createContextService } from "./context.js";

const actor = { spaceId: "space", userId: "owner" } as Actor;
function fixture() {
  const bot = { id: "chief", thread: { id: "direct" }, concurrentRuns: null };
  const tx = {
    bot: { findFirst: vi.fn(async ({ where }) => (where.id === "chief" ? bot : null)) },
    space: {
      findUniqueOrThrow: vi.fn(async () => ({
        contextBudgets: null,
        concurrentRuns: 3,
        coordinatorBotId: null,
      })),
      update: vi.fn(),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    chatGroup: {
      findFirst: vi.fn(async ({ where }) => (where.id === "alpha" ? { id: "alpha" } : null)),
    },
    thread: {
      findMany: vi.fn(async () => [
        { id: "thread-alpha", groupId: "alpha", group: { name: "Alpha" } },
        { id: "thread-beta", groupId: "beta", group: { name: "Beta" } },
      ]),
    },
    botBrief: { findUnique: vi.fn(async () => null) },
    run: { findMany: vi.fn(async () => []) },
  };
  const list = vi.fn(async ({ groupId }) => ({
    items: [
      { id: groupId, path: `briefs/${groupId}.md`, content: `## Goal\n${groupId}`, revision: 2 },
    ],
  }));
  const commit = vi.fn(async () => ({ revision: 3 }));
  const memory = { list, commit } as unknown as MemoryService;
  return { tx, list, commit, service: createContextService(tx as unknown as PrismaClient, memory) };
}
it("uses space defaults, scopes every query, and restricts configuration to the owner", async () => {
  const f = fixture();
  expect(await f.service.settings(actor, "chief")).toMatchObject({
    concurrentRuns: 3,
    budgets: { brief: 6000, summary: 4000, messages: 12000, recall: 6000 },
  });
  expect(f.tx.bot.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "chief", spaceId: "space", userId: "owner", archivedAt: null },
    }),
  );
  await expect(f.service.settings(actor, "foreign")).rejects.toThrow(IsolationError);
  await expect(f.service.configure(actor, { coordinatorBotId: "foreign" })).rejects.toThrow(
    IsolationError,
  );
  f.tx.spaceMember.findUnique.mockResolvedValueOnce({ role: "member" });
  await expect(f.service.configure(actor, { concurrentRuns: 4 })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(f.tx.space.update).not.toHaveBeenCalled();
});
it("returns two separate briefs and applies human changes with the supplied base revision", async () => {
  const f = fixture();
  const briefs = await f.service.briefs(actor, { botId: "chief" });
  expect(briefs.map((brief) => brief.content)).toEqual(["## Goal\nalpha", "## Goal\nbeta"]);
  await f.service.saveBrief(actor, {
    botId: "chief",
    groupId: "alpha",
    content: "## Goal\nOwner goal",
    expectedRevision: 2,
  });
  expect(f.commit).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "alpha",
      expectedRevision: 2,
      scope: "group",
      botId: "chief",
    }),
    expect.objectContaining({ spaceId: "space", userId: "owner" }),
  );
  expect(f.commit.mock.calls[0]?.[1].runId).toBeUndefined();
  await expect(
    f.service.saveBrief(actor, {
      botId: "chief",
      groupId: "foreign",
      content: "No",
      expectedRevision: 0,
    }),
  ).rejects.toThrow(IsolationError);
});
it("queries only the caller's requested bot and group in the seven-day window", async () => {
  const f = fixture();
  const now = new Date("2026-09-24T12:00:00Z");
  expect(await f.service.metrics(actor, { botId: "chief", groupId: "alpha" }, now)).toEqual({
    today: [],
    sevenDays: [],
  });
  expect(f.tx.run.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        spaceId: "space",
        userId: "owner",
        botId: "chief",
        thread: { groupId: "alpha" },
        createdAt: { gte: new Date("2026-09-17T12:00:00Z"), lte: now },
      },
    }),
  );
});
