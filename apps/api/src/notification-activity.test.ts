import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { notificationActivity } from "./notification-activity.js";

it("scopes the feed to memberships and applies all four account preferences", async () => {
  const row = {
    id: "run",
    threadId: "thread",
    status: "completed",
    updatedAt: new Date("2026-09-24T00:00:00Z"),
    bot: { name: "Bot", notifyOnFinish: true },
    thread: { groupId: null },
  };
  const findMany = vi.fn(async () => [
    { ...row, trigger: "user" },
    { ...row, id: "routine", trigger: "routine", status: "failed" },
    { ...row, id: "approval", status: "waiting_input" },
    { ...row, id: "dispatch", originDeviceGrantId: "phone" },
  ]);
  const prisma = {
    run: { findMany },
    userPreferences: {
      findUnique: vi.fn(async () => ({
        responseCompletions: false,
        routines: false,
        approvalsNeeded: false,
        dispatchMessages: true,
      })),
    },
  } as unknown as PrismaClient;
  const result = await notificationActivity(prisma, { userId: "owner" } as Actor);
  expect(result.activities.map((item) => [item.category, item.enabled])).toEqual([
    ["responseCompletions", false],
    ["routines", false],
    ["approvalsNeeded", false],
    ["dispatchMessages", true],
  ]);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        userId: "owner",
        space: { memberships: { some: { userId: "owner" } } },
        delegationId: null,
      }),
    }),
  );
});
