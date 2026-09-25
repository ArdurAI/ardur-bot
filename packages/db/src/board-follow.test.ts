import type { WorkItem } from "@ardurbot/contracts/board";
import { expect, it, vi } from "vitest";
import { observeBoardItems } from "./board-follow.js";
import type { PrismaClient } from "./client.js";

function fixture() {
  const follow = {
    id: "follow",
    workspaceId: "board",
    itemId: "item",
    userId: "owner",
    status: "open",
    assignee: null as string | null,
    commentCount: 0,
    version: 0,
  };
  const create = vi.fn();
  const updateMany = vi.fn(async ({ where, data }) => {
    if (where.version !== follow.version) return { count: 0 };
    Object.assign(follow, { ...data, version: follow.version + 1 });
    return { count: 1 };
  });
  const prisma = {
    boardFollow: { findMany: vi.fn(async () => [{ ...follow }]) },
    $transaction: vi.fn(async (work) =>
      work({ boardFollow: { updateMany }, boardNotification: { create } }),
    ),
  };
  return { prisma: prisma as unknown as PrismaClient, follow, create, updateMany };
}
const item = (overrides: Partial<WorkItem> = {}) =>
  ({
    id: "item",
    title: "Work",
    status: "open",
    assignee: null,
    commentCount: 0,
    ...overrides,
  }) as WorkItem;
it("records status, assignment and comment changes once per observed version", async () => {
  const { prisma, create } = fixture();
  await observeBoardItems(prisma, "board", [item()]);
  expect(create).not.toHaveBeenCalled();
  const changed = item({ status: "in_progress", assignee: "bot:Builder", commentCount: 1 });
  await observeBoardItems(prisma, "board", [changed]);
  await observeBoardItems(prisma, "board", [changed]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith({
    data: {
      followId: "follow",
      version: 1,
      title: "Work",
      changes: ["status", "assignee", "comment"],
    },
  });
  await observeBoardItems(prisma, "board", [item({ ...changed, commentCount: 0 })]);
  await observeBoardItems(prisma, "board", [changed]);
  expect(create).toHaveBeenCalledTimes(1);
});
it("does not emit after a concurrent observer consumed the version or an unfollow removed it", async () => {
  const { prisma, create, updateMany } = fixture();
  updateMany.mockResolvedValue({ count: 0 });
  await observeBoardItems(prisma, "board", [item({ status: "closed" })]);
  expect(create).not.toHaveBeenCalled();
  expect(prisma.boardFollow.findMany).toHaveBeenCalledWith({
    where: { workspaceId: "board", itemId: { in: ["item"] }, workspace: { enabled: true } },
  });
});
