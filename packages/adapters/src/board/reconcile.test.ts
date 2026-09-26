import type { BoardRun } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { reconcileBoardOutcomes } from "./reconcile.js";
import { BoardService } from "./service.js";
import type * as BoardTools from "./tools.js";
import { finishBoardRun } from "./tools.js";

vi.mock("./tools.js", async (original) => ({
  ...(await original<typeof BoardTools>()),
  finishBoardRun: vi.fn(),
}));
const runner = vi.hoisted(() => ({ calls: [] as Array<{ argv: string[]; signal: AbortSignal }> }));
vi.mock("@ardurbot/host-runtime/board/runner", () => ({
  BoardRunner: class {
    // A board command that never answers until it is stopped.
    run(request: BoardRun, _spaceId: string, signal: AbortSignal) {
      runner.calls.push({ argv: request.argv, signal });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  },
}));
afterEach(() => {
  runner.calls.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
  const stop = new AbortController();
  await reconcileBoardOutcomes(deps, { signal: stop.signal });
  expect(finishBoardRun).toHaveBeenLastCalledWith(
    deps,
    { userId: "owner", spaceId: "space", botId: "builder", runId: "run", signal: stop.signal },
    "Verified",
  );
});

it("leaves pending closes to the worker's notification tick", async () => {
  const sweep = vi.spyOn(BoardService.prototype, "sweepPendingCloses");
  const prisma = { run: { findMany: vi.fn(async () => []) } };
  await reconcileBoardOutcomes({
    prisma: prisma as unknown as PrismaClient,
    dataDir: "/fixture/app",
  });
  expect(sweep).not.toHaveBeenCalled();
});

it("stops a hung pending close at its 15-second deadline, down to the board command", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const filing = {
    id: "filing",
    spaceId: "space",
    runId: null,
    workspaceId: "workspace",
    itemId: "board-a",
    botId: "bot",
    learningProposalId: "proposal",
    closePending: "Rejected from Learning",
    closeUpdatedAt: "2026-09-25T12:00:00Z",
    closeCommentCount: 0,
    closeAttempts: null as number | null,
    closeNextAt: null as Date | null,
    closeNoticeAt: null,
    reused: false,
    createdAt: new Date(),
  };
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
    allowedBotIds: [],
  };
  const prisma = {
    run: { findMany: vi.fn(async () => []) },
    deploymentSettings: { findUnique: async () => ({ ownerUserId: "owner" }) },
    spaceMember: { findUnique: async () => ({ userId: "owner" }) },
    user: { findUniqueOrThrow: async () => ({ name: "Owner" }) },
    boardWorkspace: { findFirst: async () => workspace, findUnique: async () => workspace },
    learningProposal: { findUnique: async () => ({ id: "proposal", userId: "owner" }) },
    hostRegistration: { findUnique: async () => null },
    botBoardFiling: {
      findMany: async () => [filing],
      findUnique: async () => filing,
      updateMany: vi.fn(async ({ data }: { data: Partial<typeof filing> }) => {
        Object.assign(filing, data);
        return { count: 1 };
      }),
    },
  };
  let finished = false;
  const reconciling = reconcileBoardOutcomes(
    { prisma: prisma as unknown as PrismaClient, dataDir: "/fixture/app" },
    { pendingCloses: true },
  ).then(() => {
    finished = true;
  });
  // vi.waitFor would move the faked clock, so wait on the real event loop instead.
  while (!runner.calls.length) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(14_999);
  expect(finished).toBe(false);
  expect(runner.calls[0]?.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await reconciling;
  expect(runner.calls[0]?.argv[0]).toBe("show");
  expect(runner.calls[0]?.signal.aborted).toBe(true);
  // The interrupted close counts as a failed try and stays pending for the next sweep.
  expect(filing).toMatchObject({ closePending: "Rejected from Learning", closeAttempts: 1 });
});
