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
  const findFilings = vi.fn(async () => [] as Array<{ learningProposalId: string | null }>);
  const updateMany = vi.fn(async ({ where, data }) => {
    if (where.version !== follow.version) return { count: 0 };
    Object.assign(follow, { ...data, version: follow.version + 1 });
    return { count: 1 };
  });
  const learningProposal = { findUnique: vi.fn(async () => null), update: vi.fn() };
  const prisma = {
    boardFollow: { findMany: vi.fn(async () => [{ ...follow }]) },
    botBoardFiling: { updateMany: filing, findMany: findFilings },
    learningProposal,
    $transaction: vi.fn(async (work) =>
      work({
        boardFollow: { updateMany },
        boardNotification: { create },
        botBoardFiling: { updateMany: filing, findMany: findFilings },
        learningProposal,
      }),
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
  vi.mocked(prisma.botBoardFiling.findMany).mockResolvedValueOnce([
    { id: "filing", learningProposalId: null },
  ] as never);
  await observeBoardItems(prisma, "board", [
    item({ status: "closed", closedAt: "2026-09-25T12:00:00.000Z", closeReason: "Done" }),
  ]);
  expect(filing).toHaveBeenCalledWith({
    where: { id: "filing", closedAt: null, outcome: null },
    data: { closedAt: new Date("2026-09-25T12:00:00.000Z"), outcome: "completed" },
  });
  await observeBoardItems(prisma, "board", [
    item({ status: "closed", closedAt: "2026-09-25T12:00:00.000Z", closeReason: "Done" }),
  ]);
  expect(filing).toHaveBeenCalledTimes(1);
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
it.each([
  "nothing was resolved",
  "nothing fixed",
  "Nothing has been done",
  "nobody resolved this",
  "none resolved",
  "nowhere was this resolved",
  "unresolved",
  "unfixed",
  "undone",
  "uncompleted",
  "isn't done",
])("classifies the negated close reason %j as closed otherwise", (reason) => {
  expect(boardFilingOutcome(reason)).toBe("closed-other");
});
it.each(["ticket no 12 resolved", "case no 5 fixed", "Item no 1 done"])(
  "classifies the numbered close reason %j as completed",
  (reason) => {
    expect(boardFilingOutcome(reason)).toBe("completed");
  },
);
it("keeps a numbered label from turning a real negation into a completion", () => {
  expect(boardFilingOutcome("no fix was possible")).toBe("closed-other");
});
it("leaves the filing outcome null when the proposal close reason write fails, and the next read sets both", async () => {
  const filing = {
    id: "filing",
    learningProposalId: "proposal",
    outcome: null as string | null,
    closedAt: null as Date | null,
  };
  const proposal = {
    id: "proposal",
    body: {
      appliedBoardItem: {
        workspaceId: "board",
        itemId: "item",
        updatedAt: "2026-09-25T12:00:00.000Z",
        duplicate: false,
      },
    } as { appliedBoardItem: { closeReason?: string } },
  };
  let failWrite = true;
  const prisma = {
    botBoardFiling: {
      findMany: vi.fn(async () => (filing.outcome ? [] : [{ ...filing }])),
      updateMany: vi.fn(async ({ data }: { data: { outcome: string; closedAt: Date } }) => {
        filing.outcome = data.outcome;
        filing.closedAt = data.closedAt;
        return { count: 1 };
      }),
    },
    learningProposal: {
      findUnique: vi.fn(async () => ({ ...proposal, body: structuredClone(proposal.body) })),
      update: vi.fn(async ({ data }: { data: { body: typeof proposal.body } }) => {
        if (failWrite) throw new Error("proposal write failed");
        proposal.body = data.body;
        return proposal;
      }),
    },
    boardFollow: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const savedOutcome = filing.outcome;
      const savedClosedAt = filing.closedAt;
      const savedBody = structuredClone(proposal.body);
      try {
        return await work(prisma);
      } catch (error) {
        filing.outcome = savedOutcome;
        filing.closedAt = savedClosedAt;
        proposal.body = savedBody;
        throw error;
      }
    }),
  };
  const closed = item({
    status: "closed",
    closedAt: "2026-09-25T13:00:00.000Z",
    closeReason: "No longer needed",
  });
  await observeBoardItems(prisma as unknown as PrismaClient, "board", [closed]).catch(
    () => undefined,
  );
  expect(filing.outcome).toBeNull();
  expect(proposal.body.appliedBoardItem.closeReason).toBeUndefined();
  failWrite = false;
  await observeBoardItems(prisma as unknown as PrismaClient, "board", [closed]);
  expect(filing.outcome).toBe("closed-other");
  expect(proposal.body.appliedBoardItem.closeReason).toBe("No longer needed");
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
