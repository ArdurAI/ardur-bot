import { readFileSync } from "node:fs";
import type { BoardRun, BoardRunResult } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deliverGoalBoardRow } from "../../../packages/adapters/src/board/goal-delivery.js";

const recorded = JSON.parse(
  readFileSync(
    new URL("../../../packages/adapters/src/board/fixtures/responses.json", import.meta.url),
    "utf8",
  ),
) as { show: unknown; update: unknown; "comments add": unknown };

beforeEach(() => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function deliveryRow() {
  return {
    id: "delivery",
    goalId: "goal",
    revisionId: "revision",
    transition: "completed",
    spaceId: "space",
    userId: "owner",
    workspaceId: "workspace",
    itemId: "board-a",
    commentText: "",
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

function prismaFor(delivery: ReturnType<typeof deliveryRow>) {
  const workspace = {
    id: "workspace",
    spaceId: "space",
    ownerUserId: "owner",
    kind: "space",
    path: "/fixture/board",
    prefix: "board",
    name: "Board",
    enabled: true,
    initialized: true,
    isDefault: true,
    allowAllBots: true,
    allowedBotIds: [] as string[],
  };
  return {
    deploymentSettings: { findUnique: async () => ({ ownerUserId: "owner" }) },
    spaceMember: { findUnique: async () => ({ userId: "owner", role: "owner" }) },
    user: { findUniqueOrThrow: async () => ({ name: "Board owner" }) },
    boardWorkspace: { findFirst: async () => workspace },
    boardFollow: { findMany: async () => [] },
    botBoardFiling: { findMany: async () => [] },
    teamGoal: {
      findFirst: async () => ({
        id: "goal",
        groupId: "group",
        spaceId: "space",
        userId: "owner",
        status: "completed",
        boardWorkspaceId: "workspace",
        boardItemId: "board-a",
      }),
    },
    goalRevision: { findFirst: async () => ({ id: "revision", attempts: 1 }) },
    goalVerdict: { findFirst: async () => null },
    goalBoardDelivery: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id && where.id !== delivery.id ? null : delivery,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; claimToken?: string; state?: string };
        data: Record<string, unknown>;
      }) => {
        if (where.id && where.id !== delivery.id) return { count: 0 };
        if (where.claimToken && where.claimToken !== delivery.claimToken) return { count: 0 };
        if (where.state === "pending" && delivery.state !== "pending") return { count: 0 };
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
    },
  } as unknown as PrismaClient;
}

it("delivers a queued goal update through the owner host transport", async () => {
  const delivery = deliveryRow();
  const received: BoardRun[] = [];
  const ownerRun = async (request: BoardRun): Promise<BoardRunResult> => {
    received.push(request);
    const command = request.argv[0];
    const stdout =
      command === "show"
        ? JSON.stringify(recorded.show)
        : command === "comments"
          ? JSON.stringify(recorded["comments add"])
          : command === "history"
            ? "null"
            : JSON.stringify(recorded.update);
    return { ok: true, stdout };
  };
  await deliverGoalBoardRow(
    { prisma: prismaFor(delivery), dataDir: "/fixture", ownerRun },
    delivery,
  );
  expect(delivery.state).toBe("delivered");
  expect(delivery.failure).toBeNull();
  expect(received.some((request) => request.argv[0] === "show")).toBe(true);
  expect(received.some((request) => request.argv[0] === "comments")).toBe(true);
  expect(received[0]?.actor).toBe("Board owner");
});

it("leaves a host-bridge delivery pending when this process has no owner transport", async () => {
  const delivery = deliveryRow();
  await deliverGoalBoardRow({ prisma: prismaFor(delivery), dataDir: "/fixture" }, delivery);
  expect(delivery.state).toBe("pending");
  expect(delivery.failure).toBeNull();
  expect(delivery.claimToken).toBeNull();
});
