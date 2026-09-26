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

/** Filing rows filtered by the where clauses observeBoardItems writes. */
function filingTable(rows: Array<Record<string, unknown>>) {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (key === "OR")
        return (expected as Array<Record<string, unknown>>).some((part) => matches(row, part));
      if (key === "NOT") return !matches(row, expected as Record<string, unknown>);
      if (key === "select") return true;
      const value = row[key] ?? null;
      if (expected === null) return value === null;
      if (expected && typeof expected === "object" && !(expected instanceof Date)) {
        if ("in" in expected) return (expected.in as unknown[]).includes(value);
        if ("not" in expected) return value !== expected.not;
      }
      return value === expected;
    });
  return {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const found = rows.filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      },
    ),
  };
}
function proposalRow(body: Record<string, unknown>) {
  const row = { id: "proposal", body };
  return {
    row,
    learningProposal: {
      findUnique: vi.fn(async () => ({ ...row, body: structuredClone(row.body) })),
      update: vi.fn(async ({ data }: { data: { body: Record<string, unknown> } }) => {
        row.body = structuredClone(data.body);
        return row;
      }),
    },
  };
}
it("records a closed filing outcome once, and a reopened item clears it so the next close records afresh", async () => {
  const filing = {
    id: "filing",
    workspaceId: "board",
    itemId: "item",
    learningProposalId: "proposal",
    closedAt: null as Date | null,
    outcome: null as string | null,
  };
  const botBoardFiling = filingTable([filing]);
  const proposal = proposalRow({
    appliedBoardItem: {
      workspaceId: "board",
      itemId: "item",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
  });
  const client = {
    botBoardFiling,
    learningProposal: proposal.learningProposal,
    boardFollow: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 1),
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)),
  } as unknown as PrismaClient;
  const done = item({
    status: "closed",
    closedAt: "2026-09-25T12:00:00.000Z",
    closeReason: "Done",
  });
  await observeBoardItems(prisma, "board", [done]);
  await observeBoardItems(prisma, "board", [done]);
  expect(filing).toMatchObject({
    closedAt: new Date("2026-09-25T12:00:00.000Z"),
    outcome: "completed",
  });
  expect(proposal.row.body).toMatchObject({ appliedBoardItem: { closeReason: "Done" } });
  const writes = botBoardFiling.updateMany.mock.calls.length;

  await observeBoardItems(prisma, "board", [item({ status: "open" })]);
  expect(filing).toMatchObject({ closedAt: null, outcome: null });
  expect(proposal.row.body.appliedBoardItem).not.toHaveProperty("closeReason");
  expect(botBoardFiling.updateMany.mock.calls.length).toBe(writes + 1);

  await observeBoardItems(prisma, "board", [
    item({
      status: "closed",
      closedAt: "2026-09-26T09:00:00.000Z",
      closeReason: "No longer needed",
    }),
  ]);
  expect(filing).toMatchObject({
    closedAt: new Date("2026-09-26T09:00:00.000Z"),
    outcome: "closed-other",
  });
  expect(proposal.row.body).toMatchObject({
    appliedBoardItem: { closeReason: "No longer needed" },
  });
  expect(boardFilingOutcome("No longer needed")).toBe("closed-other");
  expect(boardFilingOutcome("")).toBe("completed");
});

it("truncates a close reason longer than the stored limit so the inbox never breaks", async () => {
  const filing = {
    id: "filing",
    workspaceId: "board",
    itemId: "item",
    learningProposalId: "proposal",
    closedAt: null as Date | null,
    outcome: null as string | null,
  };
  const botBoardFiling = filingTable([filing]);
  const proposal = proposalRow({
    appliedBoardItem: {
      workspaceId: "board",
      itemId: "item",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
  });
  const client = {
    botBoardFiling,
    learningProposal: proposal.learningProposal,
    boardFollow: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 1),
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)),
  } as unknown as PrismaClient;
  const longReason = "x".repeat(32_100);
  await observeBoardItems(prisma, "board", [
    item({ status: "closed", closedAt: "2026-09-25T12:00:00.000Z", closeReason: longReason }),
  ]);
  const stored = (proposal.row.body as { appliedBoardItem: { closeReason: string } })
    .appliedBoardItem.closeReason;
  expect(stored.length).toBe(32_000);
  expect(stored.endsWith("…")).toBe(true);
});

it("reads the filings for 200 closed items with one query", async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    id: `filing-${index}`,
    workspaceId: "board",
    itemId: `item-${index}`,
    learningProposalId: null,
    closedAt: null as Date | null,
    outcome: null as string | null,
  }));
  const botBoardFiling = filingTable(rows);
  const client = {
    botBoardFiling,
    learningProposal: { findUnique: vi.fn(), update: vi.fn() },
    boardFollow: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 1),
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)),
  } as unknown as PrismaClient;
  const closed = rows.map((row, index) =>
    item({
      id: row.itemId,
      status: "closed",
      closedAt: "2026-09-25T12:00:00.000Z",
      closeReason: index % 2 ? "Done" : "Duplicate",
    }),
  );
  await observeBoardItems(prisma, "board", closed);
  expect(botBoardFiling.findMany).toHaveBeenCalledTimes(1);
  expect(rows.filter((row) => row.outcome === "completed")).toHaveLength(100);
  expect(rows.filter((row) => row.outcome === "closed-other")).toHaveLength(100);
  botBoardFiling.findMany.mockClear();
  await observeBoardItems(prisma, "board", closed);
  expect(botBoardFiling.findMany).toHaveBeenCalledTimes(1);
});

it.each([
  "Closed",
  " closed ",
  "Implemented",
  "Shipped",
  "Merged",
  "Finished",
  "Delivered",
  "Landed",
  "Shipped in 2.4",
  "Merged the fix",
])("classifies the close reason %j that Beads or a builder writes as completed", (reason) => {
  expect(boardFilingOutcome(reason)).toBe("completed");
});
it.each([
  "not merged",
  "never shipped",
  "wasn't delivered",
  "unfinished",
  "unmerged",
  "Closed as duplicate",
  "Not implemented",
  "Couldn't get it landed",
])("classifies the close reason %j as closed otherwise", (reason) => {
  expect(boardFilingOutcome(reason)).toBe("closed-other");
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
    itemId: "item",
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
