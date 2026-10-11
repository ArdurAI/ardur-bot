import type { PrismaClient } from "@ardurbot/db";
import { expect, it } from "vitest";
import { goalLinkForbidsItemClose, goalLinkForbidsRunClose } from "./goal-link-guard.js";

const linked = {
  id: "goal",
  boardWorkspaceId: "workspace",
  boardItemId: "board-a",
};

it("blocks run closure for a coordinator or descendant of a linked goal", async () => {
  const prisma = {
    teamGoal: { findFirst: async () => linked },
  } as unknown as PrismaClient;
  await expect(
    goalLinkForbidsRunClose(prisma, {
      spaceId: "space",
      userId: "owner",
      goalId: "goal",
    }),
  ).resolves.toBe(true);
  await expect(
    goalLinkForbidsRunClose(prisma, {
      spaceId: "space",
      userId: "owner",
      delegationRootTaskId: "root",
    }),
  ).resolves.toBe(true);
});

it("blocks a direct close of the linked item and allows a different item", async () => {
  const prisma = {
    run: {
      findFirst: async () => ({
        spaceId: "space",
        userId: "owner",
        goalId: "goal",
        delegationRootTaskId: null,
        taskId: "root",
      }),
    },
    teamGoal: { findFirst: async () => linked },
  } as unknown as PrismaClient;
  const scope = { spaceId: "space", userId: "owner", botId: "builder", runId: "run" };
  await expect(goalLinkForbidsItemClose(prisma, scope, "workspace", ["board-a"])).resolves.toBe(
    true,
  );
  await expect(goalLinkForbidsItemClose(prisma, scope, "workspace", ["other"])).resolves.toBe(
    false,
  );
  await expect(goalLinkForbidsItemClose(prisma, scope, "elsewhere", ["board-a"])).resolves.toBe(
    false,
  );
});
