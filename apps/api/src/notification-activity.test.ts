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
    completedAt: null,
    attempts: [{ finishedAt: new Date("2026-09-23T23:59:59Z") }],
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
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    boardNotification: { findMany: vi.fn(async () => []) },
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
  expect(result.activities[0]).toMatchObject({
    occurredAt: row.attempts[0]!.finishedAt.toISOString(),
  });
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

it("includes only the acting owner's followed Board events with current space membership", async () => {
  const findMany = vi.fn(async () => [
    {
      id: "notice",
      title: "Plan work",
      changes: ["status"],
      createdAt: new Date("2026-09-25T00:00:00Z"),
      follow: { workspaceId: "board", itemId: "item", workspace: { spaceId: "space" } },
    },
  ]);
  const deployment = vi.fn(async () => ({ ownerUserId: "owner" }));
  const prisma = {
    run: { findMany: vi.fn(async () => []) },
    userPreferences: { findUnique: vi.fn(async () => null) },
    deploymentSettings: { findUnique: deployment },
    boardNotification: { findMany },
  } as unknown as PrismaClient;
  const result = await notificationActivity(prisma, { userId: "owner", spaceId: "space" } as Actor);
  expect(result.activities).toMatchObject([
    {
      name: "Plan work",
      status: "board_changed",
      category: "responseCompletions",
      board: { spaceId: "space", workspaceId: "board", itemId: "item" },
    },
  ]);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        OR: [
          {
            follow: {
              userId: "owner",
              workspace: {
                enabled: true,
                ownerUserId: "owner",
                space: { memberships: { some: { userId: "owner" } } },
              },
            },
          },
          {
            followId: null,
            userId: "owner",
            workspace: {
              enabled: true,
              ownerUserId: "owner",
              space: { memberships: { some: { userId: "owner" } } },
            },
          },
        ],
      },
    }),
  );
  deployment.mockResolvedValue({ ownerUserId: "new-owner" });
  expect((await notificationActivity(prisma, { userId: "owner" } as Actor)).activities).toEqual([]);
  expect(findMany).toHaveBeenCalledOnce();
});

it("includes a failed-close notice the owner did not follow and marks both notices as failed closes", async () => {
  const findMany = vi.fn(async () => [
    {
      id: "unfollowed",
      title: "A board item filed by a bot could not be closed.",
      changes: ["close"],
      createdAt: new Date("2026-09-25T01:00:00Z"),
      follow: null,
      workspaceId: "board",
      itemId: "item",
      workspace: { spaceId: "space" },
    },
    {
      id: "followed",
      title: "A board item filed by a bot could not be closed.",
      changes: ["close"],
      createdAt: new Date("2026-09-25T00:00:00Z"),
      follow: { workspaceId: "board", itemId: "other", workspace: { spaceId: "space" } },
      workspaceId: null,
      itemId: null,
      workspace: null,
    },
  ]);
  const prisma = {
    run: { findMany: vi.fn(async () => []) },
    userPreferences: { findUnique: vi.fn(async () => null) },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    boardNotification: { findMany },
  } as unknown as PrismaClient;
  const result = await notificationActivity(prisma, { userId: "owner", spaceId: "space" } as Actor);
  expect(result.activities).toMatchObject([
    {
      id: "unfollowed",
      status: "board_changed",
      threadId: "board:board:item",
      board: { spaceId: "space", workspaceId: "board", itemId: "item", closeFailed: true },
    },
    {
      id: "followed",
      threadId: "board:board:other",
      board: { spaceId: "space", workspaceId: "board", itemId: "other", closeFailed: true },
    },
  ]);
});
