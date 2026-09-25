import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { reconcileBoardOutcomes } from "./reconcile.js";
import type * as BoardTools from "./tools.js";
import { finishBoardRun } from "./tools.js";

vi.mock("./tools.js", async (original) => ({
  ...(await original<typeof BoardTools>()),
  finishBoardRun: vi.fn(),
}));
it("retries pending outcomes using the persisted result and rotates disconnected hosts", async () => {
  const run = {
    id: "run",
    userId: "owner",
    spaceId: "space",
    botId: "builder",
    status: "completed",
    error: null,
  };
  const prisma = {
    run: { findMany: vi.fn(async () => [run]), updateMany: vi.fn() },
    message: {
      findMany: vi.fn(async () => [
        { blocks: [{ kind: "text", text: "Verified" }], clientNonce: null },
      ]),
    },
  };
  const deps = { prisma: prisma as unknown as PrismaClient, dataDir: "/fixture/app" };
  vi.mocked(finishBoardRun).mockRejectedValueOnce(new Error("host disconnected"));
  await reconcileBoardOutcomes(deps);
  expect(prisma.run.updateMany).toHaveBeenCalledWith({
    where: { id: "run", boardCommentedAt: null },
    data: { updatedAt: expect.any(Date) },
  });
  await reconcileBoardOutcomes(deps);
  expect(finishBoardRun).toHaveBeenLastCalledWith(
    deps,
    { userId: "owner", spaceId: "space", botId: "builder", runId: "run" },
    "Verified",
    true,
  );
});
