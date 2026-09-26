import type { WorkItem } from "@ardurbot/contracts/board";
import { observeBoardItems } from "@ardurbot/db";
import { expect, it } from "vitest";
import { recordPendingCloseFailure } from "./pending-close.js";
import { BoardService } from "./service.js";

const beadsItem = {
  id: "board-a",
  title: "Finish the import follow-up",
  description: "",
  acceptance_criteria: "The import completes.",
  issue_type: "task",
  status: "open",
  priority: 2,
  created_at: "2026-09-25T12:00:00Z",
  updated_at: "2026-09-25T12:00:00Z",
  close_reason: "",
};

it("finishes a pending close on the next board read of that space", async () => {
  const previous = process.env.ARDURBOT_HOST_BRIDGE;
  delete process.env.ARDURBOT_HOST_BRIDGE;
  const filings = [
    {
      id: "filing",
      spaceId: "space",
      workspaceId: "workspace",
      itemId: "board-a",
      learningProposalId: "proposal",
      closePending: "Rejected from Learning",
      closeUpdatedAt: "2026-09-25T12:00:00Z",
      reused: false,
      createdAt: new Date(),
    },
  ];
  const workspace = {
    id: "workspace",
    spaceId: "space",
    ownerUserId: "owner",
    kind: "space",
    path: "",
    prefix: "work",
    name: "Board",
    enabled: true,
    initialized: true,
    isDefault: true,
    allowAllBots: true,
    allowedBotIds: [] as string[],
  };
  const prisma = {
    deploymentSettings: { findUnique: async () => ({ ownerUserId: "owner" }) },
    spaceMember: { findUnique: async () => ({ userId: "owner" }) },
    user: { findUniqueOrThrow: async () => ({ name: "Owner" }) },
    boardWorkspace: { findFirst: async () => workspace, findUnique: async () => workspace },
    learningProposal: {
      findUnique: async () => ({ id: "proposal", userId: "owner", botId: null }),
    },
    botBoardFiling: {
      findMany: async () => filings.filter((row) => row.closePending),
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const before = filings.length;
        const kept = filings.filter((row) => row.id !== where.id);
        filings.splice(0, filings.length, ...kept);
        return { count: before - filings.length };
      },
      update: async () => filings[0],
      updateMany: async () => ({ count: 0 }),
    },
    hostRegistration: { findUnique: async () => null },
  };
  const board = new BoardService({
    prisma: prisma as never,
    dataDir: "/fixture",
    localRun: async (request) => {
      const command = request.argv[0];
      if (command === "close") {
        return {
          ok: true as const,
          stdout: JSON.stringify([
            { ...beadsItem, status: "closed", close_reason: request.argv.at(-1) },
          ]),
        };
      }
      if (command === "show")
        return { ok: true as const, stdout: JSON.stringify([{ ...beadsItem }]) };
      if (command === "history") return { ok: true as const, stdout: "[]" };
      return { ok: true as const, stdout: "[]" };
    },
  });
  try {
    const provider = await board.provider({ userId: "owner", spaceId: "space" }, "workspace");
    await provider.list();
    expect(filings).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.ARDURBOT_HOST_BRIDGE;
    else process.env.ARDURBOT_HOST_BRIDGE = previous;
  }
});

function noticeStore() {
  const follow = {
    id: "follow",
    workspaceId: "workspace",
    itemId: "board-a",
    userId: "owner",
    status: "open",
    assignee: null as string | null,
    commentCount: 0,
    version: 0,
  };
  const notices: Array<{ followId: string; version: number; title: string; changes: string[] }> =
    [];
  let failCreates = 0;
  let creates = 0;
  let storedAttempts: number | null = null;
  const snapshot = () => ({
    version: follow.version,
    status: follow.status,
    assignee: follow.assignee,
    commentCount: follow.commentCount,
    notices: notices.map((row) => ({ ...row, changes: [...row.changes] })),
  });
  const restore = (saved: ReturnType<typeof snapshot>) => {
    follow.version = saved.version;
    follow.status = saved.status;
    follow.assignee = saved.assignee;
    follow.commentCount = saved.commentCount;
    notices.splice(0, notices.length, ...saved.notices);
  };
  const boardFollow = {
    upsert: async () => ({ ...follow }),
    updateMany: async ({
      where,
      data,
    }: {
      where: { version?: number };
      data: {
        version?: number | { increment: number };
        status?: string;
        assignee?: string | null;
        commentCount?: number;
      };
    }) => {
      if (where.version !== undefined && where.version !== follow.version) return { count: 0 };
      if (typeof data.version === "number") follow.version = data.version;
      else if (data.version && typeof data.version === "object")
        follow.version += data.version.increment;
      if (data.status) follow.status = data.status;
      if ("assignee" in data) follow.assignee = data.assignee ?? null;
      if (typeof data.commentCount === "number") follow.commentCount = data.commentCount;
      return { count: 1 };
    },
    findMany: async () => [{ ...follow, workspace: { enabled: true } }],
  };
  const boardNotification = {
    findFirst: async ({ where }: { where?: { followId?: string; title?: string } } = {}) =>
      notices.find(
        (row) =>
          (!where?.followId || row.followId === where.followId) &&
          (!where?.title || row.title === where.title),
      ) ?? null,
    create: async ({
      data,
    }: {
      data: { followId: string; version: number; title: string; changes: string[] };
    }) => {
      creates += 1;
      if (failCreates > 0) {
        failCreates -= 1;
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      if (notices.some((row) => row.followId === data.followId && row.version === data.version))
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      notices.push({ ...data, changes: [...data.changes] });
      return data;
    },
  };
  const handlers = {
    boardWorkspace: { findUnique: async () => ({ ownerUserId: "owner" }) },
    learningProposal: { findUnique: async () => null },
    boardFollow,
    boardNotification,
    botBoardFiling: {
      findMany: async () => [],
      updateMany: async ({
        where,
        data,
      }: {
        where: { closeAttempts?: number | null };
        data: { closeAttempts: number };
      }) => {
        if (where.closeAttempts !== storedAttempts) return { count: 0 };
        storedAttempts = data.closeAttempts;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    ...handlers,
    $transaction: async (
      work: (tx: Pick<typeof handlers, "boardFollow" | "boardNotification">) => Promise<unknown>,
    ) => {
      const saved = snapshot();
      try {
        return await work(handlers);
      } catch (error) {
        restore(saved);
        throw error;
      }
    },
  };
  return {
    prisma,
    follow,
    notices,
    creates: () => creates,
    failNextCreates(count: number) {
      failCreates = count;
    },
    setAttempts(value: number | null) {
      storedAttempts = value;
    },
  };
}

const closeFiling = (closeAttempts: number | null) => ({
  id: "filing",
  spaceId: "space",
  workspaceId: "workspace",
  itemId: "board-a",
  learningProposalId: null,
  closePending: "Rejected from Learning",
  closeAttempts,
});

it("notifies a fifth close failure at the next follow version, then a comment uses a later one", async () => {
  const { prisma, follow, notices } = noticeStore();
  for (let attempt = 0; attempt < 5; attempt += 1)
    await recordPendingCloseFailure(prisma as never, closeFiling(attempt === 0 ? null : attempt));
  expect(follow.version).toBe(1);
  expect(notices).toEqual([
    expect.objectContaining({
      version: 1,
      title: "A board item could not be closed.",
      changes: ["close"],
    }),
  ]);
  const commented = {
    id: "board-a",
    title: "Finish the import follow-up",
    status: "open",
    assignee: null,
    commentCount: 1,
  } as WorkItem;
  await observeBoardItems(prisma as never, "workspace", [commented]);
  expect(follow.version).toBe(2);
  expect(notices).toEqual([
    expect.objectContaining({ version: 1, changes: ["close"] }),
    expect.objectContaining({
      version: 2,
      title: "Finish the import follow-up",
      changes: ["comment"],
    }),
  ]);
});

it("retries one unique conflict and sends the fifth-failure notice once", async () => {
  const store = noticeStore();
  store.setAttempts(4);
  store.failNextCreates(1);
  await recordPendingCloseFailure(store.prisma as never, closeFiling(4));
  expect(store.creates()).toBe(2);
  expect(store.notices).toEqual([
    expect.objectContaining({
      version: 1,
      title: "A board item could not be closed.",
      changes: ["close"],
    }),
  ]);
  await recordPendingCloseFailure(store.prisma as never, closeFiling(5));
  expect(store.notices).toHaveLength(1);
  expect(store.follow.version).toBe(1);
});
