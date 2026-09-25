import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { parseBeadsItem } from "./beads.js";
import { reconcileBoardOutcomes } from "./reconcile.js";
import { BoardService } from "./service.js";
import { finishBoardRun } from "./tools.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const scope = { userId: "owner", spaceId: "space", botId: "builder", runId: "run" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["show", "comment", "close", "stamp"] as const)(
  "releases a failed %s attempt and retries without repeating a persisted comment",
  async (failure) => {
    const f = fixture("completed");
    if (failure === "stamp") {
      const update = f.updateMany.getMockImplementation()!;
      let fail = true;
      f.updateMany.mockImplementation(async (args) => {
        if (args.data.boardCommentedAt && fail) {
          fail = false;
          throw new Error("Unavailable");
        }
        return update(args);
      });
    } else f.provider[failure].mockRejectedValueOnce(new Error("Unavailable"));
    await expect(finishBoardRun({ prisma: f.client() }, scope, "Outcome")).rejects.toThrow(
      "Unavailable",
    );
    expect(f.run).toMatchObject({
      boardCommentedAt: null,
      boardDeliveryToken: null,
      boardDeliveryExpiresAt: null,
    });
    await reconcileBoardOutcomes({ prisma: f.client(), dataDir: "/fixture/app" });
    expect(f.item.comments).toHaveLength(1);
    expect(f.item.status).toBe("closed");
    expect(f.run.boardCommentedAt).toBeInstanceOf(Date);
  },
);

it("leaves an active claim alone and recovers a crashed worker's expired claim", async () => {
  const f = fixture("cancelled");
  f.run.boardDeliveryToken = "crashed-worker";
  f.run.boardDeliveryExpiresAt = new Date(Date.now() + 60_000);
  await reconcileBoardOutcomes({ prisma: f.client(), dataDir: "/fixture/app" });
  expect(f.provider.show).not.toHaveBeenCalled();
  f.run.boardDeliveryExpiresAt = new Date(Date.now() - 1);
  await reconcileBoardOutcomes({ prisma: f.client(), dataDir: "/fixture/app" });
  expect(f.item.comments).toHaveLength(1);
  expect(f.run).toMatchObject({ boardDeliveryToken: null, boardDeliveryExpiresAt: null });
  expect(f.run.boardCommentedAt).toBeInstanceOf(Date);
});

it("stops an expired worker before writing and preserves its successor's claim", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture("completed");
  const oldRead = deferred();
  const oldRelease = deferred();
  const newRead = deferred();
  const newRelease = deferred();
  f.provider.show
    .mockImplementationOnce(async () => {
      oldRead.resolve();
      await oldRelease.promise;
      return structuredClone(f.item);
    })
    .mockImplementationOnce(async () => {
      newRead.resolve();
      await newRelease.promise;
      return structuredClone(f.item);
    });
  const oldAttempt = finishBoardRun({ prisma: f.client() }, scope, "Outcome");
  await oldRead.promise;
  vi.setSystemTime(Date.now() + 181_000);
  const newAttempt = finishBoardRun({ prisma: f.client() }, scope, "Outcome");
  await newRead.promise;
  const successor = f.run.boardDeliveryToken;
  try {
    oldRelease.resolve();
    await expect(oldAttempt).rejects.toThrow("timed out");
    expect(f.provider.comment).not.toHaveBeenCalled();
    expect(f.run.boardDeliveryToken).toBe(successor);
    expect(f.run.boardCommentedAt).toBeNull();
  } finally {
    newRelease.resolve();
    await newAttempt;
  }
  expect(f.item.comments).toHaveLength(1);
  expect(f.run.boardCommentedAt).toBeInstanceOf(Date);
});
function fixture(status: string) {
  const run = {
    ...scope,
    id: scope.runId,
    status,
    error: "Outcome",
    boardItemId: "board-a",
    boardWorkspaceId: "workspace",
    boardCloseWhenDone: true,
    boardCommentedAt: null as Date | null,
    boardDeliveryToken: null as string | null,
    boardDeliveryExpiresAt: null as Date | null,
  };
  const item = parseBeadsItem({
    id: run.boardItemId,
    title: "Task",
    metadata: { ardur_close_when_done: true },
  });
  const provider = {
    show: vi.fn(async () => structuredClone(item)),
    comment: vi.fn(async (_id: string, text: string) => {
      item.comments.push({ id: "comment", text, author: "bot:Builder", createdAt: "" });
    }),
    close: vi.fn(async () => {
      item.status = "closed";
    }),
  };
  vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(provider as never);
  // Atomic updates share one row across client handles; PostgreSQL also checks these predicates.
  const updateMany = vi.fn(async ({ where, data }) => {
    if (where.boardDeliveryToken && where.boardDeliveryToken !== run.boardDeliveryToken)
      return { count: 0 };
    if (where.boardCommentedAt === null && run.boardCommentedAt) return { count: 0 };
    if (where.OR && run.boardDeliveryExpiresAt && run.boardDeliveryExpiresAt > new Date())
      return { count: 0 };
    if (
      where.boardDeliveryExpiresAt?.gt &&
      !(run.boardDeliveryExpiresAt && run.boardDeliveryExpiresAt > where.boardDeliveryExpiresAt.gt)
    )
      return { count: 0 };
    Object.assign(run, data);
    return { count: 1 };
  });
  const client = () =>
    ({
      run: {
        findUnique: vi.fn(async () => structuredClone(run)),
        findMany: vi.fn(async () => (run.boardCommentedAt ? [] : [structuredClone(run)])),
        update: vi.fn(async ({ data }) => Object.assign(run, data)),
        updateMany,
      },
      message: { findMany: vi.fn(async () => []) },
    }) as unknown as PrismaClient;
  return { run, item, provider, client, updateMany };
}

for (const status of ["completed", "failed", "cancelled"]) {
  it.each(["immediate", "reconciliation"])(
    `delivers ${status} once when %s overlaps the other caller`,
    async (first) => {
      const f = fixture(status);
      const read = deferred();
      const release = deferred();
      f.provider.show.mockImplementationOnce(async () => {
        const snapshot = structuredClone(f.item);
        read.resolve();
        await release.promise;
        return snapshot;
      });
      const immediate = () => finishBoardRun({ prisma: f.client() }, scope, "Outcome");
      const reconcile = () =>
        reconcileBoardOutcomes({
          prisma: f.client(),
          dataDir: "/fixture/app",
        });
      const pending = first === "immediate" ? immediate() : reconcile();
      await read.promise;
      try {
        await (first === "immediate" ? reconcile() : immediate());
      } finally {
        release.resolve();
        await pending;
      }
      expect(f.provider.comment).toHaveBeenCalledTimes(1);
      expect(f.item.comments[0]?.text).toBe(
        `[Run run] ${status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Cancelled"}\nOutcome`,
      );
      expect(f.provider.close).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
      expect(f.run.boardCommentedAt).toBeInstanceOf(Date);
      await Promise.all([immediate(), reconcile()]);
      expect(f.provider.comment).toHaveBeenCalledTimes(1);
    },
  );
}
