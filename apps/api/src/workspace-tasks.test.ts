import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { listSpaceRuns } from "./runs.js";
import { workspaceTasks } from "./workspace-tasks.js";

vi.mock("./runs.js", () => ({ listSpaceRuns: vi.fn(async () => []) }));

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

it("scopes task reads to the selected bot and its related root before loading runs", async () => {
  const bot = { findFirst: vi.fn(async () => ({ id: "bot" })) };
  const run = {
    findMany: vi.fn(async () => [{ taskId: "root", delegationRootTaskId: null }]),
  };
  const delegationRoot = { findMany: vi.fn(async () => []) };
  const delegation = { findMany: vi.fn(async () => []) };
  const routine = { findMany: vi.fn(async () => []) };
  const prisma = { bot, run, delegationRoot, delegation, routine };
  await workspaceTasks(prisma as unknown as PrismaClient, actor, "bot");
  expect(bot.findFirst).toHaveBeenCalledWith({
    where: { id: "bot", spaceId: "space", userId: "owner", archivedAt: null },
    select: { id: true },
  });
  expect(listSpaceRuns).toHaveBeenCalledWith(prisma, actor, "active", {
    botId: "bot",
    rootTaskIds: ["root"],
  });
  expect(listSpaceRuns).toHaveBeenCalledWith(prisma, actor, "recent", {
    botId: "bot",
    rootTaskIds: ["root"],
  });
  expect(delegation.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { spaceId: "space", userId: "owner", rootTaskId: { in: ["root"] } },
    }),
  );
});
