import type { JobPublisher, NotificationProvider } from "@ardurbot/adapter-kit";
import type { Pool, PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { createJobReconciler } from "../job-reconciler.js";
import { createBoardNotificationDelivery, deliverBoardNotifications } from "./notifications.js";
import { BoardService } from "./service.js";

function notificationPool(acquired = true) {
  const open = new Set<object>();
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    connect: vi.fn(async () => {
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired }] };
          return { rows: [] };
        }),
        release: vi.fn(() => {
          open.delete(client);
        }),
      };
      open.add(client);
      return client;
    }),
  };
  return { pool: pool as unknown as Pick<Pool, "connect">, open, queries };
}

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
it("says when a board item could not be closed", async () => {
  const { prisma, notifications, row } = fixture();
  prisma.boardNotification.findMany.mockResolvedValue([
    { ...row, title: "A board item could not be closed.", changes: ["close"] },
  ]);
  await deliverBoardNotifications(
    prisma as unknown as PrismaClient,
    notifications as unknown as NotificationProvider,
  );
  expect(notifications.send).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "A board item could not be closed.",
      body: "Could not close this board item.",
    }),
    expect.anything(),
  );
});
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
it("stops the whole notification batch at its deadline instead of spending a timeout per row", async () => {
  const { prisma, notifications, row } = fixture();
  prisma.boardNotification.findMany.mockResolvedValue(
    Array.from({ length: 50 }, (_, index) => ({ ...row, id: `notice-${index}` })),
  );
  const abort = new AbortController();
  let release!: () => void;
  notifications.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const delivery = deliverBoardNotifications(
    prisma as unknown as PrismaClient,
    notifications as unknown as NotificationProvider,
    abort.signal,
  );
  await vi.waitFor(() => expect(notifications.send).toHaveBeenCalledTimes(1));
  abort.abort();
  release();
  await delivery;
  expect(notifications.send).toHaveBeenCalledTimes(1);
  expect(prisma.boardNotification.update).not.toHaveBeenCalled();
});
it("keeps core recovery independent of a stalled push, bounds cycles, and aborts shutdown", async () => {
  vi.useFakeTimers();
  const { prisma, notifications } = fixture();
  let active = 0;
  let peak = 0;
  notifications.send.mockImplementation(
    (_notice, context) =>
      new Promise<void>((_resolve, reject) => {
        peak = Math.max(peak, ++active);
        context.signal.addEventListener(
          "abort",
          () => {
            --active;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  const { pool, open } = notificationPool();
  const db = Object.assign(prisma, {
    run: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
  });
  const delivery = createBoardNotificationDelivery({
    prisma: db as unknown as PrismaClient,
    notifications: notifications as unknown as NotificationProvider,
    pool,
  });
  try {
    delivery.start();
    delivery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(1);
    const core = createJobReconciler({
      prisma: db as unknown as PrismaClient,
      jobs: { enqueue: vi.fn() } as unknown as JobPublisher,
    });
    await core.reconcileOnce();
    expect(db.run.findMany).toHaveBeenCalled();
    expect(db.routine.findMany).toHaveBeenCalled();
    expect(db.computer.findMany).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(active).toBe(0);
    expect(prisma.boardNotification.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(active).toBe(1);
    expect(peak).toBe(1);
    expect(notifications.send).toHaveBeenCalledTimes(2);
  } finally {
    await delivery.stop();
    vi.useRealTimers();
  }
  expect(active).toBe(0);
  expect(open.size).toBe(0);
});
it("returns the board notification pool client after a delivery tick", async () => {
  vi.useFakeTimers();
  const { prisma, notifications } = fixture();
  const { pool, open, queries } = notificationPool();
  const delivery = createBoardNotificationDelivery({
    prisma: prisma as unknown as PrismaClient,
    notifications: notifications as unknown as NotificationProvider,
    pool,
  });
  try {
    delivery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(notifications.send).toHaveBeenCalled();
    expect(open.size).toBe(0);
    expect(queries).toContainEqual({
      sql: "SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS acquired",
      params: [1_380_019_075, 3],
    });
  } finally {
    await delivery.stop();
    vi.useRealTimers();
  }
});
it("does not drain notifications on a follower worker", async () => {
  vi.useFakeTimers();
  const { prisma, notifications } = fixture();
  const { pool, open } = notificationPool(false);
  const delivery = createBoardNotificationDelivery({
    prisma: prisma as unknown as PrismaClient,
    notifications: notifications as unknown as NotificationProvider,
    pool,
  });
  try {
    delivery.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.boardNotification.findMany).not.toHaveBeenCalled();
    expect(open.size).toBe(0);
  } finally {
    await delivery.stop();
    vi.useRealTimers();
  }
});

const beadsItem = (id: string, status = "open") => ({
  id,
  title: "Finish the import follow-up",
  description: "",
  acceptance_criteria: "",
  issue_type: "task",
  status,
  priority: 2,
  created_at: "2026-09-25T12:00:00Z",
  updated_at: "2026-09-25T12:00:00Z",
  close_reason: status === "closed" ? "Rejected from Learning" : "",
});

/** Session advisory locks on the dedicated filing pool, separate from the worker pool. */
function filingLockPool() {
  const held = new Set<string>();
  const pool = {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        const key = String(values[1]);
        if (sql.includes("pg_try_advisory_lock")) {
          if (held.has(key)) return { rows: [{ acquired: false }] };
          held.add(key);
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) held.delete(key);
        return { rows: [{ released: true }] };
      }),
      release: vi.fn(),
    })),
  };
  return { pool, held };
}

it("sweeps pending closes after delivery commits, under the tick deadline, without holding the next delivery", async () => {
  vi.useFakeTimers();
  const previousBridge = process.env.ARDURBOT_HOST_BRIDGE;
  delete process.env.ARDURBOT_HOST_BRIDGE;
  const { prisma, notifications, row } = fixture();
  const worker = notificationPool();
  const inTransaction = () =>
    worker.queries.filter((query) => query.sql === "BEGIN").length >
    worker.queries.filter((query) => query.sql === "COMMIT" || query.sql === "ROLLBACK").length;
  const lock = filingLockPool();
  const filings = ["board-a", "board-b"].map((itemId) => ({
    id: `filing-${itemId}`,
    spaceId: "space",
    workspaceId: "board",
    itemId,
    learningProposalId: null,
    closePending: "Rejected from Learning",
    closeUpdatedAt: "2026-09-25T12:00:00Z",
    closeAttempts: null,
    closeNextAt: null,
    closeNoticeAt: null,
  }));
  const workspace = {
    id: "board",
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
  const db = Object.assign(prisma, {
    user: { findUniqueOrThrow: vi.fn(async () => ({ name: "Owner" })) },
    boardWorkspace: {
      findFirst: vi.fn(async () => workspace),
      findUnique: vi.fn(async () => workspace),
    },
    learningProposal: { findUnique: vi.fn(async () => null) },
    hostRegistration: { findUnique: vi.fn(async () => null) },
    boardFollow: { findMany: vi.fn(async () => []) },
    botBoardFiling: {
      findMany: vi.fn(async () => filings.filter((filing) => filing.closePending)),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          filings.find((filing) => filing.id === where.id) ?? null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = filings.findIndex((filing) => filing.id === where.id);
        if (index >= 0) filings.splice(index, 1);
        return { count: index >= 0 ? 1 : 0 };
      }),
    },
  });
  const host: Array<{
    command: string;
    itemId: string;
    workerClients: number;
    inTransaction: boolean;
    locked: boolean;
    signal?: AbortSignal;
  }> = [];
  let closed = false;
  const board = new BoardService({
    prisma: db as never,
    dataDir: "/fixture",
    lockPool: lock.pool as never,
    localRun: async (request, scope) => {
      const command = request.argv[0] ?? "";
      const itemId = command === "close" ? String(request.argv[1]) : String(request.argv.at(-1));
      host.push({
        command,
        itemId,
        workerClients: worker.open.size,
        inTransaction: inTransaction(),
        locked: lock.held.size > 0,
        signal: scope.signal,
      });
      if (command === "show")
        return { ok: true as const, stdout: JSON.stringify([beadsItem(itemId)]) };
      if (command === "close")
        // A host close that outlives the tick and ignores the abort.
        return new Promise((resolve) =>
          setTimeout(() => {
            closed = true;
            resolve({ ok: true as const, stdout: JSON.stringify([beadsItem(itemId, "closed")]) });
          }, 40_000),
        );
      return { ok: true as const, stdout: "[]" };
    },
  });
  const delivery = createBoardNotificationDelivery({
    prisma: db as unknown as PrismaClient,
    notifications: notifications as unknown as NotificationProvider,
    pool: worker.pool,
    board,
  });
  try {
    delivery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    const close = host.find((call) => call.command === "close");
    expect(close).toMatchObject({
      itemId: "board-a",
      workerClients: 0,
      inTransaction: false,
      locked: true,
    });
    expect(host.every((call) => call.workerClients === 0 && !call.inTransaction)).toBe(true);
    expect(close?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(close?.signal?.aborted).toBe(true);

    db.boardNotification.findMany.mockResolvedValue([
      {
        ...row,
        id: "other-notice",
        title: "Other work",
        follow: { ...row.follow, itemId: "other" },
      },
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(closed).toBe(false);
    expect(notifications.send).toHaveBeenCalledTimes(2);
    expect(notifications.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Other work" }),
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed).toBe(true);
    expect(filings.map((filing) => filing.id)).toEqual(["filing-board-b"]);
    expect(host.some((call) => call.itemId === "board-b")).toBe(false);
  } finally {
    let stopped = false;
    const stopping = delivery.stop().finally(() => {
      stopped = true;
    });
    for (let turn = 0; turn < 10 && !stopped; turn += 1) await vi.advanceTimersByTimeAsync(60_000);
    await stopping;
    vi.useRealTimers();
    if (previousBridge === undefined) delete process.env.ARDURBOT_HOST_BRIDGE;
    else process.env.ARDURBOT_HOST_BRIDGE = previousBridge;
  }
  expect(worker.open.size).toBe(0);
  expect(lock.held.size).toBe(0);
});
