import { BoardService } from "@ardurbot/adapters";
import type { BoardRun } from "@ardurbot/contracts/board";
import type { HostFrame } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boardCloseRetry } from "./board.js";
import { HostBridge } from "./host-bridge.js";
import type { RouterDeps } from "./router.js";

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
const bridges: HostBridge[] = [];
beforeEach(() => {
  // The packaged api runs with the host bridge on.
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  vi.stubEnv("API_INTERNAL_URL", "http://127.0.0.1:9");
  vi.stubEnv("ENCRYPTION_KEY", "fixture-encryption-material-for-tests-only");
});
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.hub.detach();
  vi.unstubAllEnvs();
});

/** The API's board service on a real host bridge, with the desktop answering from one item. */
function fixture() {
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
  const filings = [
    {
      id: "filing",
      spaceId: "space",
      runId: null,
      workspaceId: "workspace",
      itemId: "board-a",
      botId: "bot",
      learningProposalId: "proposal",
      closePending: "Undone from Learning",
      closeUpdatedAt: "2026-09-25T12:00:00Z",
      closeCommentCount: 0,
      closeAttempts: null as number | null,
      closeNextAt: null,
      closeNoticeAt: null,
      reused: false,
      createdAt: new Date(),
    },
  ];
  const client = {
    hostRegistration: {
      findUnique: async () => ({ userId: "owner", generation: "generation", hostRoots: [] }),
    },
    deploymentSettings: {
      findUnique: async () => ({ ownerUserId: "owner", computerHost: "this-mac" }),
    },
    spaceMember: { findUnique: async () => ({ userId: "owner", role: "owner" }) },
    user: {
      findUnique: async () => ({ name: "Board owner" }),
      findUniqueOrThrow: async () => ({ name: "Board owner" }),
    },
    bot: {
      findFirst: async () => ({ id: "bot", name: "Builder", computer: { kind: "desktop" } }),
    },
    run: { findFirst: async () => null },
    boardWorkspace: { findFirst: async () => workspace, findUnique: async () => workspace },
    learningProposal: { findUnique: async () => ({ id: "proposal", userId: "owner" }) },
    boardFollow: { findMany: async () => [] },
    botBoardFiling: {
      findMany: async () => filings.filter((row) => row.closePending),
      findUnique: async ({ where }: { where: { id: string } }) =>
        filings.find((row) => row.id === where.id) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const before = filings.length;
        filings.splice(0, filings.length, ...filings.filter((row) => row.id !== where.id));
        return { count: before - filings.length };
      },
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    ...client,
    $transaction: async (work: (tx: typeof client) => Promise<unknown>) => work(client),
  } as unknown as PrismaClient;
  const bridge = new HostBridge(prisma, "fixture-encryption-material");
  bridges.push(bridge);
  const received: BoardRun[] = [];
  const host = {
    close: vi.fn(),
    send: vi.fn(async (frame: HostFrame) => {
      if (frame.type !== "request" || frame.operation.op !== "board.run") return;
      const request = frame.operation.request;
      received.push(request);
      const command = request.argv[0];
      const data =
        command === "show"
          ? JSON.stringify([beadsItem])
          : command === "close"
            ? JSON.stringify([{ ...beadsItem, status: "closed", close_reason: request.argv[3] }])
            : "[]";
      await bridge.hub.fromHost(host, {
        v: 1,
        type: "stream",
        id: frame.id,
        seq: 0,
        channel: "stdout",
        data,
      });
      await bridge.hub.fromHost(host, {
        v: 1,
        type: "stream",
        id: frame.id,
        seq: 1,
        channel: "result",
        data: { ok: true },
      });
      await bridge.hub.fromHost(host, { v: 1, type: "end", id: frame.id });
    }),
  };
  bridge.hub.attach(host, "owner", "generation");
  const service = new BoardService({
    prisma,
    dataDir: "/fixture",
    ownerRun: (request, scope) => bridge.runBoard(request, scope),
  });
  return { service, received, filings, host, prisma, bridge };
}

it("reads a learning proposal's board as the owner through the desktop connection", async () => {
  const { service, received } = fixture();
  const provider = await service.provider(
    { userId: "owner", spaceId: "space", botId: "bot" },
    "workspace",
  );
  await expect(provider.show("board-a")).resolves.toMatchObject({ id: "board-a" });
  expect(received[0]).toMatchObject({
    actor: "Board owner",
    argv: expect.arrayContaining(["show"]),
  });
});

it("finishes a bot's pending close through the desktop connection", async () => {
  const { service, received, filings } = fixture();
  await service.sweepPendingCloses();
  expect(received.map((request) => request.argv[0])).toContain("close");
  expect(received.find((request) => request.argv[0] === "close")).toMatchObject({
    actor: "Board owner",
    argv: ["close", "board-a", "--reason", "Undone from Learning"],
  });
  expect(filings).toEqual([]);
});

it.each(["graphile", "memory"])(
  "retries a failed close on its own schedule with the host bridge on (WAKEUP_DRIVER=%s)",
  async (driver) => {
    vi.stubEnv("WAKEUP_DRIVER", driver);
    const { received, filings, prisma, bridge } = fixture();
    const retry = boardCloseRetry({ prisma, dataDir: "/fixture", hostBridge: bridge });
    expect(retry).toBeDefined();
    retry?.start();
    try {
      await vi.waitFor(() => expect(filings).toEqual([]));
    } finally {
      await retry?.stop();
    }
    expect(received.find((request) => request.argv[0] === "close")?.argv).toEqual([
      "close",
      "board-a",
      "--reason",
      "Undone from Learning",
    ]);
  },
);

it("leaves pending closes to the worker without the host bridge", () => {
  const { prisma, bridge } = fixture();
  expect(boardCloseRetry({ prisma, dataDir: "/fixture", hostBridge: bridge }, {})).toBeUndefined();
});

it("gives the router only the filing lock pool", () => {
  // @ts-expect-error The router never used the shared pool, so it is not a dependency.
  const unused: RouterDeps["pool"] = undefined;
  expect(unused).toBeUndefined();
});
