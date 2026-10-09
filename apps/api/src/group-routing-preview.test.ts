import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { resolveThreadTarget } from "./thread-target.js";

const actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const members = ["a", "b"].map((id) => ({
  bot: { id, name: id.toUpperCase(), color: null, runs: [] },
}));
it.each([
  ["a", "b", "b", "a"],
  [null, "b", "a", "b"],
  [null, null, "b", "b"],
  [null, null, null, "a"],
  ["foreign", "foreign", "foreign", "a"],
] as const)(
  "projects coordinator %s, last %s, space %s to %s",
  async (coord, last, space, expected) => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "room",
      name: "Room",
      coordinatorBotId: coord,
      members,
      space: { coordinatorBotId: space },
      thread: { id: "thread", runs: last ? [{ botId: last }] : [] },
    });
    const prisma = { chatGroup: { findFirst } } as unknown as PrismaClient;
    const target = await resolveThreadTarget(prisma, actor, { groupId: "room" });
    expect(target.kind).toBe("group");
    if (target.kind !== "group") throw new Error("expected group");
    expect(target.groupRouting).toEqual({
      coordinatorBotId: coord === "a" ? "a" : null,
      defaultBotId: expected,
    });
    const query = findFirst.mock.calls[0]![0];
    expect(query.where).toEqual({
      id: "room",
      spaceId: "space",
      userId: "owner",
      archivedAt: null,
    });
    expect(query.include.thread.select.runs).toEqual({
      where: { spaceId: "space", userId: "owner" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
      select: { botId: true },
    });
    expect(query.include.space).toEqual({ select: { coordinatorBotId: true } });
    expect(query.include.members.where).toEqual({ bot: { archivedAt: null } });
    expect(Object.keys(target.groupRouting!)).toEqual(["coordinatorBotId", "defaultBotId"]);
  },
);
it("refuses an inaccessible room before exposing routing or its roster", async () => {
  const prisma = {
    chatGroup: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient;
  await expect(resolveThreadTarget(prisma, actor, { groupId: "foreign" })).rejects.toBeInstanceOf(
    IsolationError,
  );
});
