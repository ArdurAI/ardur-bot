import { expect, it } from "vitest";
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
  close_reason: "",
};

it("finishes a pending close on the next board read of that space", async () => {
  const previous = process.env.ARDURBOT_HOST_BRIDGE;
  delete process.env.ARDURBOT_HOST_BRIDGE;
  const filings = [
    {
      id: "filing",
      spaceId: "space",
      workspaceId: "workspace",
      itemId: "board-a",
      learningProposalId: "proposal",
      closePending: "Rejected from Learning",
      reused: false,
      createdAt: new Date(),
    },
  ];
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
  const prisma = {
    deploymentSettings: { findUnique: async () => ({ ownerUserId: "owner" }) },
    spaceMember: { findUnique: async () => ({ userId: "owner" }) },
    user: { findUniqueOrThrow: async () => ({ name: "Owner" }) },
    boardWorkspace: { findFirst: async () => workspace, findUnique: async () => workspace },
    learningProposal: {
      findUnique: async () => ({ id: "proposal", userId: "owner", botId: null }),
    },
    botBoardFiling: {
      findMany: async () => filings.filter((row) => row.closePending),
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const before = filings.length;
        const kept = filings.filter((row) => row.id !== where.id);
        filings.splice(0, filings.length, ...kept);
        return { count: before - filings.length };
      },
      update: async () => filings[0],
      updateMany: async () => ({ count: 0 }),
    },
    hostRegistration: { findUnique: async () => null },
  };
  const board = new BoardService({
    prisma: prisma as never,
    dataDir: "/fixture",
    localRun: async (request) => {
      const command = request.argv[0];
      if (command === "close") {
        return {
          ok: true as const,
          stdout: JSON.stringify([
            { ...beadsItem, status: "closed", close_reason: request.argv.at(-1) },
          ]),
        };
      }
      if (command === "show")
        return { ok: true as const, stdout: JSON.stringify([{ ...beadsItem }]) };
      if (command === "history") return { ok: true as const, stdout: "[]" };
      return { ok: true as const, stdout: "[]" };
    },
  });
  try {
    const provider = await board.provider({ userId: "owner", spaceId: "space" }, "workspace");
    await provider.list();
    expect(filings).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.ARDURBOT_HOST_BRIDGE;
    else process.env.ARDURBOT_HOST_BRIDGE = previous;
  }
});
