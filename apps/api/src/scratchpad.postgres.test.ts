import type { JobPublisher } from "@ardurbot/adapter-kit";
import { EncryptedSecretStore } from "@ardurbot/adapters";
import type { BoardRunResult } from "@ardurbot/contracts/board";
import { createDb } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

type BeadsItem = Record<string, unknown>;

const beadsItem = (id: string, title: string, status: string): BeadsItem => ({
  id,
  title,
  status,
  description: "",
  issue_type: "task",
  priority: 2,
  created_at: "2026-01-01T00:00:00Z",
  created_by: "board-owner",
  updated_at: "2026-01-01T00:00:00Z",
});

describePostgres("scratchpad board linking (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let call: (method: string, input: unknown) => Promise<Response | undefined>;
  const owner = { spaceId: "scratchpad-fixture-space", userId: "scratchpad-fixture-owner" };
  const foreignSpaceId = "scratchpad-fixture-foreign-space";
  const botId = "scratchpad-fixture-bot";
  const boardWorkspaceId = "scratchpad-fixture-board";
  const foreignBoardWorkspaceId = "scratchpad-fixture-foreign-board";
  const actor = {
    ...owner,
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  // The board worker is faked at its transport seam: an enqueued board.run command is
  // answered straight into the board_commands table the way a real Beads CLI run would,
  // so the router, board service and provider all run for real without a board or Beads.
  const boardItems = new Map<string, BeadsItem>();
  const boardCalls: string[][] = [];
  const answerBoardCommand = (argv: string[]): BoardRunResult => {
    const [command, ...rest] = argv;
    switch (command) {
      case "list":
        return { ok: true, stdout: JSON.stringify([...boardItems.values()]) };
      case "ready":
        return {
          ok: true,
          stdout: JSON.stringify([...boardItems.values()].filter((item) => item.status === "open")),
        };
      case "blocked":
        return { ok: true, stdout: "[]" };
      case "show": {
        const item = boardItems.get(rest[rest.length - 1]!);
        return { ok: true, stdout: JSON.stringify(item ? [item] : []) };
      }
      case "history":
        return { ok: true, stdout: "[]" };
      case "update": {
        const item = boardItems.get(rest[0]!);
        const statusFlag = rest.indexOf("--status");
        if (item && statusFlag !== -1) item.status = rest[statusFlag + 1];
        return { ok: true, stdout: "null" };
      }
      case "close": {
        const reasonFlag = rest.indexOf("--reason");
        const closed = rest.slice(0, reasonFlag).flatMap((id) => {
          const item = boardItems.get(id);
          if (item) {
            item.status = "closed";
            item.closed_at = "2026-01-02T00:00:00Z";
            item.close_reason = rest[reasonFlag + 1];
          }
          return item ? [item] : [];
        });
        return { ok: true, stdout: JSON.stringify(closed) };
      }
      default:
        return {
          ok: false,
          problem: { code: "command_failed", message: `Unexpected board command: ${command}` },
        };
    }
  };
  const jobs = {
    enqueue: async (job: Parameters<JobPublisher["enqueue"]>[0]) => {
      if (job.name !== "board.run") throw new Error(`Unexpected job: ${job.name}`);
      const row = await db.prisma.boardCommand.findUniqueOrThrow({
        where: { id: job.payload.requestId },
      });
      const argv = (row.request as { argv?: string[] }).argv ?? [];
      boardCalls.push(argv);
      await db.prisma.boardCommand.update({
        where: { id: row.id },
        data: { status: "finished", result: answerBoardCommand(argv) },
      });
    },
    cancel: async () => undefined,
    close: async () => undefined,
  } as JobPublisher;
  const expectBadRequest = async (response: Response | undefined, message: string) => {
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({ code: "BAD_REQUEST", message }),
    });
  };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.user.create({
      data: { id: owner.userId, name: "Test Owner", email: "scratchpad@fixture.invalid" },
    });
    for (const spaceId of [owner.spaceId, foreignSpaceId]) {
      await db.prisma.organization.create({
        data: {
          id: spaceId,
          name: "Test Space",
          slug: spaceId,
          createdAt: new Date(),
          spaces: { create: { id: spaceId, name: "Test Space" } },
          members: {
            create: { id: `${spaceId}-member`, userId: owner.userId, role: "owner", createdAt: new Date() },
          },
        },
      });
    }
    await db.prisma.spaceMember.create({
      data: {
        id: "scratchpad-fixture-space-member",
        userId: owner.userId,
        spaceId: owner.spaceId,
        organizationId: owner.spaceId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await db.prisma.deploymentSettings.create({
      data: { id: "default", ownerUserId: owner.userId },
    });
    await db.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Test bot",
        modelId: "test-model",
        color: "blue",
      },
    });
    for (const [id, spaceId] of [
      [boardWorkspaceId, owner.spaceId],
      [foreignBoardWorkspaceId, foreignSpaceId],
    ] as const) {
      await db.prisma.boardWorkspace.create({
        data: {
          id,
          spaceId,
          ownerUserId: owner.userId,
          kind: "space",
          prefix: "TEST",
          path: `scratchpad-test-board-${id}`,
          name: "Scratchpad Test Board",
          enabled: true,
          allowAllBots: true,
          allowedBotIds: [],
        },
      });
    }
    boardItems.set("item1", beadsItem("item1", "Item 1", "open"));
    boardItems.set("item2", beadsItem("item2", "Item 2", "closed"));
    const handler = new RPCHandler(
      createRouter({
        prisma: db.prisma,
        secrets: new EncryptedSecretStore("fixture-scratchpad-encryption-material"),
        jobs,
        env: { webOrigin: "https://app.example.test" },
      } as unknown as RouterDeps),
    );
    call = async (method, input) => {
      const { response } = await handler.handle(
        new Request(`https://app.example.test/rpc/scratchpad/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response;
    };
  });

  afterAll(async () => {
    if (db) {
      try {
        await db.prisma.scratchpadItem.deleteMany({
          where: { spaceId: { in: [owner.spaceId, foreignSpaceId] } },
        });
        await db.prisma.boardWorkspace.deleteMany({
          where: { id: { in: [boardWorkspaceId, foreignBoardWorkspaceId] } },
        });
        await db.prisma.bot.deleteMany({ where: { id: botId } });
        await db.prisma.deploymentSettings.deleteMany({ where: { ownerUserId: owner.userId } });
        await db.prisma.organization.deleteMany({
          where: { id: { in: [owner.spaceId, foreignSpaceId] } },
        });
        await db.prisma.user.deleteMany({ where: { id: owner.userId } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });

  it("rejects a board outside the space, a disabled board, a bot that is not allowed and unknown items", async () => {
    await expectBadRequest(
      await call("linkBoardItems", {
        botId,
        boardWorkspaceId: foreignBoardWorkspaceId,
        boardItemIds: ["item1"],
      }),
      "Board not found or disabled",
    );
    await db.prisma.boardWorkspace.update({
      where: { id: boardWorkspaceId },
      data: { enabled: false },
    });
    await expectBadRequest(
      await call("linkBoardItems", { botId, boardWorkspaceId, boardItemIds: ["item1"] }),
      "Board not found or disabled",
    );
    await db.prisma.boardWorkspace.update({
      where: { id: boardWorkspaceId },
      data: { enabled: true, allowAllBots: false },
    });
    await expectBadRequest(
      await call("linkBoardItems", { botId, boardWorkspaceId, boardItemIds: ["item1"] }),
      "Bot not allowed on board",
    );
    await db.prisma.boardWorkspace.update({
      where: { id: boardWorkspaceId },
      data: { allowAllBots: true },
    });
    await expectBadRequest(
      await call("linkBoardItems", { botId, boardWorkspaceId, boardItemIds: ["item3"] }),
      "Item item3 not found on board",
    );
  });

  it("links several items in one transaction and refuses duplicates", async () => {
    // A partially invalid batch writes nothing at all.
    await expectBadRequest(
      await call("linkBoardItems", { botId, boardWorkspaceId, boardItemIds: ["item1", "item3"] }),
      "Item item3 not found on board",
    );
    expect(
      await db.prisma.scratchpadItem.count({ where: { spaceId: owner.spaceId, botId } }),
    ).toBe(0);

    const response = await call("linkBoardItems", {
      botId,
      boardWorkspaceId,
      boardItemIds: ["item1", "item2"],
    });
    expect(response?.status).toBe(200);
    const linked = (
      (await response?.json()) as {
        json: Array<{ id: string; boardItemId: string; title: string; status: string }>;
      }
    ).json;
    // Both rows share one createdAt, so the database may return them in either order.
    expect([...linked.map((item) => item.boardItemId)].sort()).toEqual(["item1", "item2"]);
    expect(linked.find((item) => item.boardItemId === "item1")).toMatchObject({
      title: "Item 1",
      status: "open",
    });
    expect(linked.find((item) => item.boardItemId === "item2")).toMatchObject({
      title: "Item 2",
      status: "open",
    });

    await expectBadRequest(
      await call("linkBoardItems", { botId, boardWorkspaceId, boardItemIds: ["item1"] }),
      "Duplicate link refused",
    );
    expect(
      await db.prisma.scratchpadItem.count({ where: { spaceId: owner.spaceId, botId } }),
    ).toBe(2);
  });

  it("removing a linked item never touches the board", async () => {
    const linked = await db.prisma.scratchpadItem.findFirstOrThrow({
      where: { botId, boardWorkspaceId, boardItemId: "item2" },
    });
    const callsBefore = boardCalls.length;
    const response = await call("remove", { itemId: linked.id });
    expect(response?.status).toBe(200);
    expect(boardCalls).toHaveLength(callsBefore);
    expect(await db.prisma.scratchpadItem.findUnique({ where: { id: linked.id } })).toBeNull();
  });

  it("a status change on a linked item goes to the board", async () => {
    const linked = await db.prisma.scratchpadItem.findFirstOrThrow({
      where: { botId, boardWorkspaceId, boardItemId: "item1" },
    });
    const progress = await call("update", { itemId: linked.id, status: "in_progress" });
    expect(progress?.status).toBe(200);
    await expect(progress?.json()).resolves.toEqual({
      json: expect.objectContaining({ status: "in_progress" }),
    });
    expect(boardCalls).toContainEqual(["update", "item1", "--status", "in_progress"]);

    const done = await call("update", { itemId: linked.id, status: "done" });
    expect(done?.status).toBe(200);
    await expect(done?.json()).resolves.toEqual({
      json: expect.objectContaining({ status: "done" }),
    });
    expect(boardCalls).toContainEqual(["close", "item1", "--reason", "done"]);
    expect(boardItems.get("item1")?.status).toBe("closed");
  });
});
