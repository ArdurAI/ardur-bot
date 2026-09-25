import type { WorkItem } from "@ardurbot/contracts/board";
import { expect, it, vi } from "vitest";
import { boardFilingOutcome, observeBoardItems } from "./board-follow.js";
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
  const filing = vi.fn(async () => ({ count: 0 }));
  const updateMany = vi.fn(async ({ where, data }) => {
    if (where.version !== follow.version) return { count: 0 };
    Object.assign(follow, { ...data, version: follow.version + 1 });
    return { count: 1 };
  });
  const prisma = {
    boardFollow: { findMany: vi.fn(async () => [{ ...follow }]) },
    botBoardFiling: { updateMany: filing },
    $transaction: vi.fn(async (work) =>
      work({ boardFollow: { updateMany }, boardNotification: { create } }),
    ),
  };
  return { prisma: prisma as unknown as PrismaClient, follow, create, updateMany, filing };
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

it("records a closed filing outcome once and never overwrites it", async () => {
  const { prisma, filing } = fixture();
  await observeBoardItems(prisma, "board", [
    item({ status: "closed", closedAt: "2026-09-25T12:00:00.000Z", closeReason: "Done" }),
  ]);
  expect(filing).toHaveBeenCalledWith({
    where: { workspaceId: "board", itemId: "item", closedAt: null, outcome: null },
    data: { closedAt: new Date("2026-09-25T12:00:00.000Z"), outcome: "completed" },
  });
  expect(boardFilingOutcome("No longer needed")).toBe("closed-other");
  expect(boardFilingOutcome("")).toBe("completed");
});
it.each([
  "Not done",
  "not fixed",
  "won't fix",
  "Cannot complete",
  "can’t complete this",
  "Has not been resolved",
  "Didn't get it done",
  "Done? Not fixed yet.",
])("classifies the negated close reason %j as closed otherwise", (reason) => {
  expect(boardFilingOutcome(reason)).toBe("closed-other");
});
it.each(["Done", "Fixed in the next build", "Resolved, not a duplicate", "Completed", "  "])(
  "classifies the close reason %j as completed",
  (reason) => {
    expect(boardFilingOutcome(reason)).toBe("completed");
  },
);
it("does not emit after a concurrent observer consumed the version or an unfollow removed it", async () => {
  const { prisma, create, updateMany } = fixture();
  updateMany.mockResolvedValue({ count: 0 });
  await observeBoardItems(prisma, "board", [item({ status: "closed" })]);
  expect(create).not.toHaveBeenCalled();
  expect(prisma.boardFollow.findMany).toHaveBeenCalledWith({
    where: { workspaceId: "board", itemId: { in: ["item"] }, workspace: { enabled: true } },
  });
});
