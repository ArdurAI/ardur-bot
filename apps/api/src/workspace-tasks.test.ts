import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
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
  expect(run.findMany).toHaveBeenCalledWith({
    where: { spaceId: "space", userId: "owner", botId: "bot" },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { taskId: true, delegationRootTaskId: true },
  });
  expect(delegationRoot.findMany).toHaveBeenNthCalledWith(1, {
    where: { spaceId: "space", userId: "owner", coordinatorBotId: "bot" },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { rootTaskId: true },
  });
  expect(delegation.findMany).toHaveBeenNthCalledWith(1, {
    where: {
      spaceId: "space",
      userId: "owner",
      OR: [{ requesterBotId: "bot" }, { actingBotId: "bot" }],
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { rootTaskId: true },
  });
  expect(listSpaceRuns).toHaveBeenCalledWith(prisma, actor, "active", {
    botId: "bot",
    rootTaskIds: ["root"],
  });
  expect(listSpaceRuns).toHaveBeenCalledWith(prisma, actor, "recent", {
    botId: "bot",
    rootTaskIds: ["root"],
  });
  expect(delegation.findMany).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      where: { spaceId: "space", userId: "owner", rootTaskId: { in: ["root"] } },
    }),
  );
  expect(routine.findMany).toHaveBeenCalledWith({
    where: { spaceId: "space", userId: "owner", botId: "bot" },
    select: { id: true, name: true, nextRunAt: true },
  });
  expect(delegationRoot.findMany).toHaveBeenNthCalledWith(2, {
    where: { spaceId: "space", userId: "owner", rootTaskId: { in: ["root"] } },
    select: { rootTaskId: true, coordinatorThreadId: true },
  });
});

it("throws an isolation error when the bot is missing or outside the actor scope", async () => {
  const bot = { findFirst: vi.fn(async () => null) };
  const prisma = { bot, run: { findMany: vi.fn() } };
  await expect(
    workspaceTasks(prisma as unknown as PrismaClient, actor, "other-bot"),
  ).rejects.toThrow(IsolationError);
  expect(bot.findFirst).toHaveBeenCalledWith({
    where: { id: "other-bot", spaceId: "space", userId: "owner", archivedAt: null },
    select: { id: true },
  });
});
