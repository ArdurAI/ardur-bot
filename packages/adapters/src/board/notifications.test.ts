import type { NotificationProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { deliverBoardNotifications } from "./notifications.js";

function fixture() {
  const workspace = { id: "board", spaceId: "space", ownerUserId: "owner", enabled: true };
  const row = {
    id: "notice",
    title: "Ready work",
    changes: ["status", "assignee", "comment"],
    follow: { userId: "owner", itemId: "item", workspace },
  };
  const prisma = {
    boardNotification: { findMany: vi.fn(async () => [row]), update: vi.fn() },
    spaceMember: { findUnique: vi.fn(async () => ({ userId: "owner" })) },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    userPreferences: { findUnique: vi.fn(async () => null) },
  };
  const notifications = { send: vi.fn() };
  const deliver = () =>
    deliverBoardNotifications(
      prisma as unknown as PrismaClient,
      notifications as unknown as NotificationProvider,
    );
  return { prisma, row, notifications, deliver };
}
it("delivers follower changes through the existing provider with the Board deep-link target", async () => {
  const { prisma, notifications, deliver } = fixture();
  await deliver();
  expect(notifications.send).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "board",
      title: "Ready work",
      body: "Status changed · Assignee changed · New comment",
      board: { spaceId: "space", workspaceId: "board", itemId: "item" },
    }),
    expect.objectContaining({ userId: "owner", spaceId: "space" }),
  );
  expect(prisma.boardNotification.update).toHaveBeenCalledWith({
    where: { id: "notice" },
    data: { deliveredAt: expect.any(Date) },
  });
});
it.each(["membership", "owner", "archive", "preference"])(
  "rechecks %s before notification delivery",
  async (reason) => {
    const { prisma, row, notifications, deliver } = fixture();
    if (reason === "membership") prisma.spaceMember.findUnique.mockResolvedValue(null as never);
    if (reason === "owner")
      prisma.deploymentSettings.findUnique.mockResolvedValue({ ownerUserId: "other" });
    if (reason === "archive") row.follow.workspace.enabled = false;
    if (reason === "preference")
      prisma.userPreferences.findUnique.mockResolvedValue({ responseCompletions: false } as never);
    await deliver();
    expect(notifications.send).not.toHaveBeenCalled();
    expect(prisma.boardNotification.update).toHaveBeenCalled();
  },
);
it("leaves delivery pending after a transport failure", async () => {
  const { prisma, notifications, deliver } = fixture();
  notifications.send.mockRejectedValue(new Error("offline"));
  await deliver();
  expect(prisma.boardNotification.update).not.toHaveBeenCalled();
});
