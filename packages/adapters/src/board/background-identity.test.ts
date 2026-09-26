import type { BoardProblem, BoardRun } from "@ardurbot/contracts/board";
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * A learning filing whose Reject already committed, owned by bot "bot" in space "space". The
 * returned state lets a test archive the bot, change the item, or hand the computer to someone
 * else between sweeps.
 */
function fixture(
  options: {
    archivedBot?: boolean;
    untickedBot?: boolean;
    itemStatus?: string;
    itemUpdatedAt?: string;
    boardOff?: boolean;
    itemDeleted?: boolean;
    showProblem?: BoardProblem;
  } = {},
) {
  const state = {
    archivedBot: options.archivedBot ?? false,
    itemStatus: options.itemStatus ?? beadsItem.status,
    itemUpdatedAt: options.itemUpdatedAt ?? beadsItem.updated_at,
    computerOwner: "owner",
    boardOff: options.boardOff ?? false,
    itemDeleted: options.itemDeleted ?? false,
    showProblem: options.showProblem as BoardProblem | undefined,
    proposalBody: { status: "rejected" } as Record<string, unknown>,
  };
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
    allowAllBots: !options.untickedBot,
    allowedBotIds: [] as string[],
  };
  const client = {
    deploymentSettings: {
      findUnique: async () => ({ ownerUserId: state.computerOwner, computerHost: "this-mac" }),
    },
    spaceMember: { findUnique: async () => ({ userId: "owner" }) },
    user: { findUniqueOrThrow: async () => ({ name: "Owner" }) },
    bot: {
      findFirst: async () =>
        state.archivedBot ? null : { id: "bot", name: "Builder", computer: { kind: "desktop" } },
    },
    boardWorkspace: {
      // findFirst is workspace()'s own lookup (filtered by enabled: true); findUnique is
      // closeNoticeOwner's, which only ever needs the still-existing row's owner.
      findFirst: async () => (state.boardOff ? null : workspace),
      findUnique: async () => workspace,
    },
    learningProposal: {
      findUnique: async () => ({ id: "proposal", userId: "owner", body: state.proposalBody }),
      update: vi.fn(async ({ data }: { data: { body: Record<string, unknown> } }) => {
        state.proposalBody = data.body;
        return { id: "proposal" };
      }),
    },
    $executeRaw: async () => 1,
    boardFollow: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "follow",
        version: 0,
        ...data,
      }),
      updateMany: async () => ({ count: 1 }),
    },
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
    if (command === "show") {
      if (state.showProblem) return { ok: false as const, problem: state.showProblem };
      return {
        ok: true as const,
        stdout: state.itemDeleted
          ? "[]"
          : JSON.stringify([
              {
                ...beadsItem,
                status: state.itemStatus,
                updated_at: state.itemUpdatedAt,
                ...(state.itemStatus === "closed" ? { close_reason: "Handled by hand" } : {}),
              },
            ]),
      };
    }
    if (command === "close")
      return {
        ok: true as const,
        stdout: JSON.stringify([{ ...beadsItem, status: "closed", close_reason: request.argv[3] }]),
      };
    return { ok: true as const, stdout: "[]" };
  });
  return { prisma, filing, filings, requests, ownerRun, state };
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
  // Approve opens the proposal's bot board without a run.
  const provider = await app.provider({ userId: "owner", spaceId: "space", botId: "bot" });
  await expect(provider.show("board-a")).resolves.toMatchObject({ id: "board-a" });
  expect(ownerRun).toHaveBeenCalledWith(
    expect.objectContaining({ actor: "Owner", argv: expect.arrayContaining(["show"]) }),
    expect.objectContaining({ userId: "owner", spaceId: "space", botId: undefined }),
  );
  expect(requests.every((request) => request.actor === "Owner")).toBe(true);
});

it("ends a pending close quietly when a person already closed the item, whatever the filing's bot can do", async () => {
  const { prisma, filings, requests, ownerRun } = fixture({
    archivedBot: true,
    itemStatus: "closed",
  });
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  await app.sweepPendingCloses();
  expect(requests.map((request) => [request.argv[0], request.actor])).toEqual([
    ["show", "Owner"],
    ["history", "Owner"],
  ]);
  expect(filings).toEqual([]);
  expect(prisma.boardNotification.create).not.toHaveBeenCalled();
});

it.each([
  ["archived", { archivedBot: true }],
  ["no longer allowed on the board", { untickedBot: true }],
])(
  "retries a pending close as the person who asked for it when the filing's bot is %s",
  async (_label, denied) => {
    // Reject and Undo close with the person's own board access, so the retry does too.
    const { prisma, filings, requests, ownerRun } = fixture({ ...denied, itemStatus: "open" });
    const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
    await app.sweepPendingCloses();
    expect(requests.map((request) => [request.argv[0], request.actor])).toEqual([
      ["show", "Owner"],
      ["history", "Owner"],
      ["close", "Owner"],
    ]);
    expect(requests.at(-1)?.argv).toEqual([
      "close",
      "board-a",
      "--reason",
      "Rejected from Learning",
    ]);
    expect(filings).toEqual([]);
    expect(prisma.boardNotification.create).not.toHaveBeenCalled();
  },
);

it("closes as the person, never as the filing's bot, without the host bridge", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  const { prisma, filings, requests, ownerRun } = fixture();
  const app = new BoardService({
    prisma: prisma as never,
    dataDir: "/fixture",
    localRun: (request) => ownerRun(request),
  });
  await app.sweepPendingCloses();
  expect(requests.map((request) => [request.argv[0], request.actor])).toEqual([
    ["show", "Owner"],
    ["history", "Owner"],
    ["close", "Owner"],
  ]);
  expect(filings).toEqual([]);
});

it("releases the close as changed when the person edited the item and kept it open, whatever the filing's bot can do", async () => {
  const { prisma, filings, requests, ownerRun, state } = fixture({
    archivedBot: true,
    itemStatus: "open",
    itemUpdatedAt: "2026-09-25T13:00:00Z",
  });
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  await app.sweepPendingCloses();
  expect(requests.map((request) => request.argv[0])).not.toContain("close");
  expect(state.proposalBody).toMatchObject({ boardChanged: true });
  expect(filings).toEqual([]);
  expect(prisma.boardNotification.create).not.toHaveBeenCalled();
});

it("drops a pending close for good, with no notice, when the person who asked for it lost access", async () => {
  const { prisma, filings, requests, ownerRun, state } = fixture({ archivedBot: true });
  // The computer now belongs to someone else, so the person's own board access is gone too.
  state.computerOwner = "someone-else";
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  await app.sweepPendingCloses();
  expect(requests).toEqual([]);
  expect(filings).toEqual([]);
  expect(prisma.boardNotification.create).not.toHaveBeenCalled();
});

it("drops a pending close for good, with no notice, when the board was turned off", async () => {
  const { prisma, filings, requests, ownerRun } = fixture({ boardOff: true });
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  await app.sweepPendingCloses();
  expect(requests).toEqual([]);
  expect(filings).toEqual([]);
  expect(prisma.boardNotification.create).not.toHaveBeenCalled();
});

it("drops a pending close for good, with no notice, when the item was deleted outside the app", async () => {
  const { prisma, filings, requests, ownerRun } = fixture({ itemDeleted: true });
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  await app.sweepPendingCloses();
  expect(requests.map((request) => request.argv[0])).toEqual(["show"]);
  expect(filings).toEqual([]);
  expect(prisma.boardNotification.create).not.toHaveBeenCalled();
});

it("counts a failed try for a transient failure, and sends the notice after five", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  const { prisma, filing, filings, ownerRun } = fixture({
    showProblem: { code: "timeout", message: "The board command timed out." },
  });
  const app = new BoardService({ prisma: prisma as never, dataDir: "/fixture", ownerRun });
  await app.sweepPendingCloses();
  expect(filings).toEqual([filing]);
  expect(filing).toMatchObject({
    closePending: "Rejected from Learning",
    closeAttempts: 1,
    closeNextAt: new Date("2026-09-25T12:00:00.000Z"),
    closeNoticeAt: null,
  });
  expect(prisma.boardNotification.create).not.toHaveBeenCalled();
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    await app.sweepPendingCloses();
  }
  expect(filing.closeAttempts).toBe(5);
  expect(prisma.boardNotification.create).toHaveBeenCalledExactlyOnceWith({
    data: expect.objectContaining({
      title: "A board item filed by a bot could not be closed.",
      changes: ["close"],
    }),
  });
});

it("gives the executor only the filing lock pool", () => {
  // @ts-expect-error The executor never used the shared pool, so it is not a dependency.
  const unused: ExecutorDeps["pool"] = undefined;
  expect(unused).toBeUndefined();
});
