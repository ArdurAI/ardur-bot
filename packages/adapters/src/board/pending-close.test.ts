import type { WorkItem } from "@ardurbot/contracts/board";
import { observeBoardItems } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import {
  pendingCloseAction,
  recordPendingCloseFailure,
  releaseChangedBoardClose,
} from "./pending-close.js";
import { BoardService } from "./service.js";

it("ends a pending close quietly when a person closed the item with a different reason", () => {
  const filing = {
    closePending: "Rejected from Learning",
    closeUpdatedAt: "2026-09-25T12:00:00.000Z",
    closeCommentCount: 0,
  };
  expect(
    pendingCloseAction(
      {
        status: "closed",
        closeReason: "Kept for the shop",
        updatedAt: "2026-09-25T13:00:00.000Z",
        commentCount: 1,
      },
      filing,
    ),
  ).toBe("done");
  expect(
    pendingCloseAction(
      { status: "closed", closeReason: "Rejected from Learning", updatedAt: filing.closeUpdatedAt },
      filing,
    ),
  ).toBe("done");
  expect(
    pendingCloseAction(
      { status: "open", updatedAt: filing.closeUpdatedAt, commentCount: 0 },
      filing,
    ),
  ).toBe("close");
  expect(
    pendingCloseAction(
      { status: "open", updatedAt: "2026-09-25T13:00:00.000Z", commentCount: 0 },
      filing,
    ),
  ).toBe("changed");
});

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
      findUnique: async ({ where }: { where: { id: string } }) =>
        filings.find((row) => row.id === where.id) ?? null,
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
  let failWith: Error | undefined;
  let creates = 0;
  let storedAttempts: number | null = null;
  let noticeAt: Date | null = null;
  const snapshot = () => ({
    noticeAt,
    version: follow.version,
    status: follow.status,
    assignee: follow.assignee,
    commentCount: follow.commentCount,
    notices: notices.map((row) => ({ ...row, changes: [...row.changes] })),
  });
  const restore = (saved: ReturnType<typeof snapshot>) => {
    noticeAt = saved.noticeAt;
    follow.version = saved.version;
    follow.status = saved.status;
    follow.assignee = saved.assignee;
    follow.commentCount = saved.commentCount;
    notices.splice(0, notices.length, ...saved.notices);
  };
  const boardFollow = {
    upsert: async () => ({ ...follow }),
    findUnique: async () => ({ ...follow }),
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
        throw failWith ?? Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
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
        where: { closeAttempts?: number | null; closeNoticeAt?: null };
        data: { closeAttempts?: number; closeNoticeAt?: Date };
      }) => {
        if ("closeNoticeAt" in where) {
          if (noticeAt) return { count: 0 };
          noticeAt = data.closeNoticeAt ?? null;
          return { count: 1 };
        }
        if (where.closeAttempts !== storedAttempts) return { count: 0 };
        storedAttempts = data.closeAttempts ?? null;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    ...handlers,
    $transaction: async (work: (tx: typeof handlers) => Promise<unknown>) => {
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
    noticeAt: () => noticeAt,
    failNextCreates(count: number, error?: Error) {
      failCreates = count;
      failWith = error;
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
      title: "A board item filed by a bot could not be closed.",
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
      title: "A board item filed by a bot could not be closed.",
      changes: ["close"],
    }),
  ]);
  await recordPendingCloseFailure(store.prisma as never, closeFiling(5));
  expect(store.notices).toHaveLength(1);
  expect(store.follow.version).toBe(1);
});

it("sends the close notice on attempt six when attempt five could not store it, then never again", async () => {
  const store = noticeStore();
  store.setAttempts(4);
  store.failNextCreates(1, new Error("Connection terminated unexpectedly"));
  await recordPendingCloseFailure(store.prisma as never, closeFiling(4));
  expect(store.notices).toEqual([]);
  expect(store.noticeAt()).toBeNull();
  await recordPendingCloseFailure(store.prisma as never, closeFiling(5));
  expect(store.notices).toEqual([
    expect.objectContaining({
      version: 1,
      title: "A board item filed by a bot could not be closed.",
      changes: ["close"],
    }),
  ]);
  expect(store.noticeAt()).toBeInstanceOf(Date);
  await recordPendingCloseFailure(store.prisma as never, closeFiling(6));
  await recordPendingCloseFailure(store.prisma as never, closeFiling(7));
  expect(store.notices).toHaveLength(1);
  expect(store.follow.version).toBe(1);
});

/** One learning proposal row shared by two writers, with Postgres row locks and a pausable read. */
function proposalRace() {
  let body: Record<string, unknown> = {
    id: "proposal",
    appliedBoardItem: {
      workspaceId: "workspace",
      itemId: "board-a",
      updatedAt: "2026-09-25T12:00:00Z",
      duplicate: false,
    },
  };
  const filings = [
    {
      id: "filing",
      spaceId: "space",
      itemId: "board-a",
      learningProposalId: "proposal",
      closePending: "Undone from Learning" as string | null,
      closedAt: null as Date | null,
      outcome: null as string | null,
    },
  ];
  const rowLocks = new Map<string, Promise<void>>();
  const paused: Array<() => void> = [];
  let pauseNext = false;
  let reads = 0;
  const client = (held: Array<() => void>) => ({
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join("").includes("FOR UPDATE")) return 1;
      const id = String(values[0]);
      while (rowLocks.has(id)) await rowLocks.get(id);
      let unlock = () => {};
      rowLocks.set(
        id,
        new Promise<void>((resolve) => {
          unlock = resolve;
        }),
      );
      held.push(() => {
        rowLocks.delete(id);
        unlock();
      });
      return 1;
    },
    learningProposal: {
      findUnique: async () => {
        const copy = structuredClone(body);
        reads += 1;
        if (pauseNext) {
          pauseNext = false;
          await new Promise<void>((resolve) => paused.push(resolve));
        }
        return { body: copy, userId: "owner" };
      },
      update: async ({ data }: { data: { body: Record<string, unknown> } }) => {
        body = structuredClone(data.body);
        return { body };
      },
    },
    botBoardFiling: {
      findMany: async () =>
        filings
          .filter((row) => !row.closedAt && !row.outcome)
          .map((row) => ({
            id: row.id,
            itemId: row.itemId,
            learningProposalId: row.learningProposalId,
          })),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown> & { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = filings.find(
          (filing) =>
            filing.id === where.id &&
            Object.entries(where).every(
              ([key, value]) => (filing as Record<string, unknown>)[key] === value,
            ),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const index = filings.findIndex((row) => row.id === where.id);
        if (index >= 0) filings.splice(index, 1);
        return { count: index >= 0 ? 1 : 0 };
      },
    },
    boardFollow: { findMany: async () => [] },
  });
  const prisma = {
    ...client([]),
    $transaction: async (work: (tx: ReturnType<typeof client>) => Promise<unknown>) => {
      const held: Array<() => void> = [];
      try {
        return await work(client(held));
      } finally {
        for (const unlock of held) unlock();
      }
    },
  };
  return {
    prisma,
    body: () => body,
    reads: () => reads,
    pauseNextRead() {
      pauseNext = true;
    },
    resume() {
      paused.shift()?.();
    },
  };
}

it.each(["outcome", "changed"] as const)(
  "keeps boardChanged and closeReason when the %s write reads first and commits last",
  async (first) => {
    const race = proposalRace();
    const personClosed = {
      id: "board-a",
      title: "Finish the import follow-up",
      status: "closed",
      closeReason: "Kept for the shop",
      closedAt: "2026-09-25T12:05:00Z",
      assignee: null,
      commentCount: 0,
    } as WorkItem;
    const changedFiling = {
      id: "filing",
      spaceId: "space",
      workspaceId: "workspace",
      itemId: "board-a",
      learningProposalId: "proposal",
      closePending: "Undone from Learning",
    };
    const outcome = () => observeBoardItems(race.prisma as never, "workspace", [personClosed]);
    const changed = () => releaseChangedBoardClose(race.prisma as never, changedFiling);
    race.pauseNextRead();
    const firstWrite = first === "outcome" ? outcome() : changed();
    await vi.waitFor(() => expect(race.reads()).toBe(1));
    const secondWrite = first === "outcome" ? changed() : outcome();
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    race.resume();
    await Promise.all([firstWrite, secondWrite]);
    expect(race.body()).toMatchObject({
      boardChanged: true,
      appliedBoardItem: expect.objectContaining({ closeReason: "Kept for the shop" }),
    });
  },
);

it("writes nothing when the filing no longer matches the close being released", async () => {
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const update = vi.fn(async () => undefined);
  const tx = {
    $executeRaw: async () => undefined,
    learningProposal: {
      findUnique: async () => ({ body: { boardClosing: true } }),
      update,
    },
    botBoardFiling: { deleteMany },
  };
  const prisma = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx) };
  const filing = {
    id: "filing",
    spaceId: "space",
    workspaceId: "workspace",
    itemId: "board-a",
    learningProposalId: "proposal",
    closePending: "Undone from Learning",
  };
  await releaseChangedBoardClose(prisma as never, filing);
  expect(deleteMany).toHaveBeenCalledWith({
    where: { id: "filing", spaceId: "space", closePending: "Undone from Learning" },
  });
  expect(update).not.toHaveBeenCalled();
});

it("releases a pending close when someone commented, even though the comment left updatedAt alone", async () => {
  const previous = process.env.ARDURBOT_HOST_BRIDGE;
  delete process.env.ARDURBOT_HOST_BRIDGE;
  const filings = [
    {
      id: "filing",
      spaceId: "space",
      workspaceId: "workspace",
      itemId: "board-a",
      botId: null,
      learningProposalId: null,
      closePending: "Undone from Learning",
      closeUpdatedAt: "2026-09-25T12:00:00Z",
      closeCommentCount: 0,
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
  const commands: string[] = [];
  const client = {
    deploymentSettings: { findUnique: async () => ({ ownerUserId: "owner" }) },
    spaceMember: { findUnique: async () => ({ userId: "owner" }) },
    user: { findUniqueOrThrow: async () => ({ name: "Owner" }) },
    boardWorkspace: { findFirst: async () => workspace, findUnique: async () => workspace },
    learningProposal: { findUnique: async () => null },
    boardFollow: { findMany: async () => [] },
    botBoardFiling: {
      findMany: async () => filings.filter((row) => row.closePending),
      findUnique: async ({ where }: { where: { id: string } }) =>
        filings.find((row) => row.id === where.id) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const before = filings.length;
        filings.splice(0, filings.length, ...filings.filter((row) => row.id !== where.id));
        return { count: before - filings.length };
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: object }) => {
        const row = filings.find((filing) => filing.id === where.id);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    hostRegistration: { findUnique: async () => null },
  };
  const prisma = {
    ...client,
    $transaction: async (work: (tx: typeof client) => Promise<unknown>) => work(client),
  };
  const board = new BoardService({
    prisma: prisma as never,
    dataDir: "/fixture",
    localRun: async (request) => {
      commands.push(request.argv[0] ?? "");
      if (request.argv[0] === "show")
        return {
          ok: true as const,
          stdout: JSON.stringify([
            { ...beadsItem, comment_count: 1, comments: [{ id: 1, text: "I'm taking this" }] },
          ]),
        };
      return { ok: true as const, stdout: "[]" };
    },
  });
  try {
    await board.sweepPendingCloses();
    expect(commands).not.toContain("close");
    expect(filings).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.ARDURBOT_HOST_BRIDGE;
    else process.env.ARDURBOT_HOST_BRIDGE = previous;
  }
});

type FollowRow = {
  id: string;
  workspaceId: string;
  itemId: string;
  userId: string;
  status: string;
  assignee: string | null;
  commentCount: number;
  version: number;
};
/** A follow table that may start empty, and notices that may have no follow. */
function followStore(existing: Partial<FollowRow> | null) {
  let follow: FollowRow | null = existing
    ? {
        id: "follow",
        workspaceId: "workspace",
        itemId: "board-a",
        userId: "owner",
        status: "open",
        assignee: null,
        commentCount: 0,
        version: 0,
        ...existing,
      }
    : null;
  const notices: Array<Record<string, unknown>> = [];
  let noticeAt: Date | null = null;
  let attempts: number | null = 4;
  const created = (data: Omit<FollowRow, "id" | "version"> & { version?: number }) => {
    follow = { id: "follow", version: 0, ...data };
    return { ...follow };
  };
  const client = {
    boardWorkspace: { findUnique: async () => ({ ownerUserId: "owner" }) },
    learningProposal: { findUnique: async () => null },
    boardFollow: {
      upsert: async ({ create }: { create: Omit<FollowRow, "id" | "version"> }) =>
        follow ? { ...follow } : created(create),
      findUnique: async () => (follow ? { ...follow } : null),
      create: async ({ data }: { data: Omit<FollowRow, "id" | "version"> }) => {
        if (follow) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        return created(data);
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { version?: number };
        data: { version?: number | { increment: number } };
      }) => {
        if (!follow || (where.version !== undefined && where.version !== follow.version))
          return { count: 0 };
        follow.version =
          typeof data.version === "number"
            ? data.version
            : follow.version + (data.version?.increment ?? 0);
        return { count: 1 };
      },
    },
    boardNotification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notices.push({ ...data });
        return data;
      },
    },
    botBoardFiling: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { closeAttempts?: number | null; closeNoticeAt?: null };
        data: { closeAttempts?: number; closeNoticeAt?: Date };
      }) => {
        if ("closeNoticeAt" in where) {
          if (noticeAt) return { count: 0 };
          noticeAt = data.closeNoticeAt ?? null;
          return { count: 1 };
        }
        if (where.closeAttempts !== attempts) return { count: 0 };
        attempts = data.closeAttempts ?? null;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    ...client,
    $transaction: async (work: (tx: typeof client) => Promise<unknown>) => work(client),
  };
  return { prisma, notices, follow: () => follow };
}

it("adds the fifth-failure notice to the owner's existing follow without changing what they follow", async () => {
  const store = followStore({ status: "in_progress", assignee: "Owner", commentCount: 2 });
  const show = vi.fn();
  await recordPendingCloseFailure(store.prisma as never, closeFiling(4), show);
  expect(show).not.toHaveBeenCalled();
  expect(store.follow()).toMatchObject({
    status: "in_progress",
    assignee: "Owner",
    commentCount: 2,
    version: 1,
  });
  expect(store.notices).toEqual([
    {
      followId: "follow",
      version: 1,
      title: "A board item filed by a bot could not be closed.",
      changes: ["close"],
    },
  ]);
});

it("follows the item from its real state when the owner did not follow it", async () => {
  const store = followStore(null);
  const show = vi.fn(async () => ({
    id: "board-a",
    status: "in_progress",
    assignee: "bot:Builder",
    commentCount: 3,
  }));
  await recordPendingCloseFailure(store.prisma as never, closeFiling(4), show as never);
  expect(show).toHaveBeenCalledWith("board-a");
  expect(store.follow()).toMatchObject({
    workspaceId: "workspace",
    itemId: "board-a",
    userId: "owner",
    status: "in_progress",
    assignee: "bot:Builder",
    commentCount: 3,
    version: 1,
  });
  expect(store.notices).toEqual([
    expect.objectContaining({ followId: "follow", version: 1, changes: ["close"] }),
  ]);
});

it("stores the notice without a follow when the item cannot be shown", async () => {
  const store = followStore(null);
  const show = vi.fn(async () => {
    throw new Error("Open the desktop app to use this board.");
  });
  await recordPendingCloseFailure(store.prisma as never, closeFiling(4), show as never);
  expect(store.follow()).toBeNull();
  expect(store.notices).toEqual([
    {
      userId: "owner",
      workspaceId: "workspace",
      itemId: "board-a",
      version: 0,
      title: "A board item filed by a bot could not be closed.",
      changes: ["close"],
    },
  ]);
});
