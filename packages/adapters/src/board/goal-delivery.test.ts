import { readFileSync } from "node:fs";
import { goalBoardDeliveryKey } from "@ardurbot/contracts";
import { BoardError } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { BeadsBoardProvider } from "./beads.js";
import { deliverGoalBoardRow } from "./goal-delivery.js";
import { goalBoardHash } from "./goal-delivery-key.js";
import { BoardService } from "./service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function row(transition: "completed" | "accepted") {
  return {
    id: "delivery",
    goalId: "goal",
    revisionId: "revision",
    transition,
    spaceId: "space",
    userId: "owner",
    workspaceId: "workspace",
    itemId: "board-a",
    commentText: "Goal completed\n/app/g/group?goal=goal&revision=revision",
    state: "pending",
    claimToken: null as string | null,
    claimGeneration: 0,
    claimExpiresAt: null as Date | null,
    commentReceipt: null as string | null,
    closeReceipt: null as string | null,
    retryAt: null as Date | null,
    attempts: 0,
    failure: null as string | null,
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function harness(
  transition: "completed" | "accepted",
  options: { linked?: boolean; current?: boolean } = {},
) {
  const delivery = row(transition);
  const goal = {
    id: "goal",
    groupId: "group",
    spaceId: "space",
    userId: "owner",
    status: transition === "accepted" ? "accepted" : "completed",
    boardWorkspaceId: options.linked === false ? "other" : "workspace",
    boardItemId: options.linked === false ? "other-item" : "board-a",
  };
  const revision = { id: options.current === false ? "newer" : "revision", attempts: 2 };
  const writes: Array<{ close: boolean }> = [];
  const provider = {
    deliverKeyed: vi.fn(async (input: { close: boolean }) => {
      writes.push({ close: input.close });
      return {
        commentId: "comment-1",
        commented: true,
        closedByThisDelivery: input.close,
        alreadyClosed: false,
        leftOpen: !input.close,
        discrepancy: false,
        expired: false,
      };
    }),
    show: vi.fn(async () => ({
      id: "board-a",
      comments: [],
      status: "open",
      closeWhenDone: false,
    })),
    comment: vi.fn(),
    close: vi.fn(),
  };
  vi.spyOn(BoardService.prototype, "actor").mockResolvedValue("Owner");
  vi.spyOn(BoardService.prototype, "workspace").mockResolvedValue({
    id: "workspace",
    spaceId: "space",
    ownerUserId: "owner",
  } as never);
  vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(provider as never);
  vi.spyOn(BoardService.prototype, "withFilingLock").mockImplementation(async (_scope, work) =>
    work(),
  );
  const updateMany = vi.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (where.id && where.id !== delivery.id) return { count: 0 };
      if (where.claimToken && where.claimToken !== delivery.claimToken) return { count: 0 };
      if (where.state === "pending" && delivery.state !== "pending") return { count: 0 };
      if (
        typeof where.claimGeneration === "number" &&
        where.claimGeneration !== delivery.claimGeneration
      )
        return { count: 0 };
      if (where.OR && delivery.claimExpiresAt && delivery.claimExpiresAt > new Date())
        return { count: 0 };
      const next = { ...data };
      const generation = next.claimGeneration as { increment?: number } | undefined;
      if (generation?.increment) {
        delivery.claimGeneration += generation.increment;
        delete next.claimGeneration;
      }
      const attempts = next.attempts as { increment?: number } | undefined;
      if (attempts?.increment) {
        delivery.attempts += attempts.increment;
        delete next.attempts;
      }
      Object.assign(delivery, next);
      return { count: 1 };
    },
  );
  const prisma = {
    goalBoardDelivery: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id) return where.id === delivery.id ? delivery : null;
        const key = where.goalId_revisionId_transition as { transition?: string } | undefined;
        if (key?.transition === "completed" && transition === "accepted") return null;
        return delivery;
      }),
      updateMany,
    },
    teamGoal: { findFirst: vi.fn(async () => goal) },
    goalRevision: { findFirst: vi.fn(async () => revision) },
    goalVerdict: {
      findFirst: vi.fn(async () => (transition === "accepted" ? { type: "accept" } : null)),
    },
    run: { create: vi.fn() },
  } as unknown as PrismaClient;
  return { delivery, provider, prisma, writes };
}

it("comments a completed result once and does not close or start a run", async () => {
  const f = harness("completed");
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.writes).toEqual([{ close: false }]);
  expect(f.delivery.state).toBe("delivered");
  expect(f.delivery.closeReceipt).toBe("left-open");
  expect(
    (f.prisma as unknown as { run: { create: ReturnType<typeof vi.fn> } }).run.create,
  ).not.toHaveBeenCalled();
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.provider.deliverKeyed).toHaveBeenCalledTimes(1);
});

it("closes only the accepted revision, and records an already-closed item without claiming the close", async () => {
  const f = harness("accepted");
  f.provider.deliverKeyed.mockResolvedValue({
    commentId: "comment-1",
    commented: true,
    closedByThisDelivery: false,
    alreadyClosed: true,
    leftOpen: false,
    discrepancy: false,
    expired: false,
  });
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.provider.deliverKeyed).toHaveBeenCalledWith(expect.objectContaining({ close: true }));
  expect(f.delivery).toMatchObject({ state: "delivered", closeReceipt: "already-closed" });
});

it("leaves an outage pending and never starts another run", async () => {
  const f = harness("completed");
  f.provider.deliverKeyed.mockRejectedValue(new BoardError({ code: "timeout", message: "slow" }));
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.delivery.state).toBe("pending");
  expect(f.delivery.failure).toBe("Board unavailable");
  expect(f.delivery.claimToken).toBeNull();
  expect(
    (f.prisma as unknown as { run: { create: ReturnType<typeof vi.fn> } }).run.create,
  ).not.toHaveBeenCalled();
});

it("pauses a superseded acceptance instead of closing", async () => {
  const f = harness("accepted", { current: false });
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.provider.deliverKeyed).not.toHaveBeenCalled();
  expect(f.delivery.state).toBe("paused");
});

it("asks the owner when the link changed and does not write", async () => {
  const f = harness("completed", { linked: false });
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.provider.deliverKeyed).not.toHaveBeenCalled();
  expect(f.delivery.state).toBe("needs-owner");
});

it("does not comment through a provider that cannot deduplicate", async () => {
  const f = harness("completed");
  f.provider.deliverKeyed = undefined as never;
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.provider.comment).not.toHaveBeenCalled();
  expect(f.provider.close).not.toHaveBeenCalled();
  expect(f.delivery.state).toBe("pending");
});

it("pauses a receipt discrepancy for owner review instead of leaving it pending", async () => {
  const recorded = JSON.parse(
    readFileSync(new URL("./fixtures/responses.json", import.meta.url), "utf8"),
  ) as {
    show: Array<
      Record<string, unknown> & { metadata: Record<string, unknown>; comments: unknown[] }
    >;
  };
  const item = structuredClone(recorded.show[0])!;
  const hash = goalBoardHash(goalBoardDeliveryKey("goal", "revision", "completed"));
  item.metadata[`ardur_gd_${hash}`] = "1:c1:x0";
  item.comments = [];
  const calls: string[][] = [];
  const beads = new BeadsBoardProvider({
    workspace: {
      id: "workspace",
      kind: "space",
      name: "Board",
      path: "/fixture/board",
      prefix: "board",
      enabled: true,
      isDefault: true,
      allowAllBots: true,
      allowedBotIds: [],
      initialized: true,
    },
    actor: "Owner",
    run: async (request) => {
      calls.push(request.argv);
      if (request.argv[0] === "show") return { ok: true, stdout: JSON.stringify([item]) };
      if (request.argv[0] === "history") return { ok: true, stdout: "null" };
      return { ok: true, stdout: "null" };
    },
  });
  const f = harness("completed");
  vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(beads as never);
  await deliverGoalBoardRow({ prisma: f.prisma, dataDir: "/fixture/app" }, f.delivery);
  expect(f.delivery.state).toBe("paused");
  expect(f.delivery.failure).toBe("Board update pending");
  expect(calls.filter((argv) => ["update", "comments", "close"].includes(argv[0] ?? ""))).toEqual(
    [],
  );
});
