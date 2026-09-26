import type { BoardRun } from "@ardurbot/contracts/board";
import { getLogger } from "@ardurbot/logging";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor.js";
import { BoardService } from "./service.js";

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
  comment_count: 0,
  close_reason: "",
};

beforeEach(() => {
  // The packaged images run the api and the worker with the host bridge on.
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  // Nothing here may reach a real service: a request that escapes would fail to connect.
  vi.stubEnv("API_INTERNAL_URL", "http://127.0.0.1:9");
  vi.stubEnv("ENCRYPTION_KEY", "fixture-encryption-material-for-tests-only");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A learning filing whose Reject already committed, owned by bot "bot" in space "space". */
function fixture() {
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
    closeNoticeAt: null as Date | null,
    reused: false,
    createdAt: new Date(),
  };
  const filings = [filing];
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
  const client = {
    deploymentSettings: {
      findUnique: async () => ({ ownerUserId: "owner", computerHost: "this-mac" }),
    },
    spaceMember: { findUnique: async () => ({ userId: "owner" }) },
    user: { findUniqueOrThrow: async () => ({ name: "Owner" }) },
    bot: {
      findFirst: async () => ({ id: "bot", name: "Builder", computer: { kind: "desktop" } }),
    },
    boardWorkspace: { findFirst: async () => workspace, findUnique: async () => workspace },
    learningProposal: { findUnique: async () => ({ id: "proposal", userId: "owner" }) },
    boardFollow: { findMany: async () => [], findUnique: async () => null },
    boardNotification: { create: vi.fn() },
    hostRegistration: { findUnique: async () => null },
    botBoardFiling: {
      findMany: async () => filings.filter((row) => row.closePending),
      findUnique: async ({ where }: { where: { id: string } }) =>
        filings.find((row) => row.id === where.id) ?? null,
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const before = filings.length;
        filings.splice(0, filings.length, ...filings.filter((row) => row.id !== where.id));
        return { count: before - filings.length };
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = filings.find((item) => item.id === where.id);
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        },
      ),
    },
  };
  const prisma = {
    ...client,
    $transaction: async (work: (tx: typeof client) => Promise<unknown>) => work(client),
  };
  const requests: BoardRun[] = [];
  /** Stands in for the API's host bridge: the owner's connection to the desktop. */
  const ownerRun = vi.fn(async (request: BoardRun) => {
    requests.push(request);
    const command = request.argv[0];
    if (command === "show") return { ok: true as const, stdout: JSON.stringify([beadsItem]) };
    if (command === "close")
      return {
        ok: true as const,
        stdout: JSON.stringify([{ ...beadsItem, status: "closed", close_reason: request.argv[3] }]),
      };
    return { ok: true as const, stdout: "[]" };
  });
  return { prisma, filing, filings, requests, ownerRun };
}

it("leaves a pending close for the app when this process has no owner connection to the host", async () => {
  const { prisma, filing, ownerRun } = fixture();
  const debug = vi.spyOn(getLogger(), "debug");
  // The worker, the reconciler and a run's outcome delivery build their service this way.
  const worker = new BoardService({ prisma: prisma as never, dataDir: "/fixture" });
  await worker.sweepPendingCloses();
  expect(ownerRun).not.toHaveBeenCalled();
  expect(prisma.botBoardFiling.updateMany).not.toHaveBeenCalled();
  expect(filing).toMatchObject({
    closePending: "Rejected from Learning",
    closeAttempts: null,
    closeNoticeAt: null,
  });
  expect(prisma.boardNotification.create).not.toHaveBeenCalled();
  expect(debug).toHaveBeenCalledWith(
    "pending board close",
    expect.objectContaining({ reason: expect.stringContaining("host") }),
  );
});

it("finishes the close through the owner's host connection in the app", async () => {
  const { prisma, filings, requests, ownerRun } = fixture();
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  await app.sweepPendingCloses();
  expect(requests.map((request) => [request.argv[0], request.actor])).toEqual([
    ["show", "Owner"],
    ["history", "Owner"],
    ["close", "Owner"],
  ]);
  expect(requests.at(-1)?.argv).toEqual(["close", "board-a", "--reason", "Rejected from Learning"]);
  expect(filings).toEqual([]);
});

it("reads a bot's board outside a run through the owner's host connection", async () => {
  const { prisma, requests, ownerRun } = fixture();
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  // Approve, Reject and Undo open the proposal's bot board without a run.
  const provider = await app.provider({ userId: "owner", spaceId: "space", botId: "bot" });
  await expect(provider.show("board-a")).resolves.toMatchObject({ id: "board-a" });
  expect(ownerRun).toHaveBeenCalledWith(
    expect.objectContaining({ actor: "Owner", argv: expect.arrayContaining(["show"]) }),
    expect.objectContaining({ userId: "owner", spaceId: "space", botId: undefined }),
  );
  expect(requests.every((request) => request.actor === "Owner")).toBe(true);
});

it("gives the executor only the filing lock pool", () => {
  // @ts-expect-error The executor never used the shared pool, so it is not a dependency.
  const unused: ExecutorDeps["pool"] = undefined;
  expect(unused).toBeUndefined();
});
