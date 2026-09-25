import { BoardService } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { BoardError, WorkItemSchema } from "@ardurbot/contracts/board";
import { afterEach, expect, it, vi } from "vitest";
import { createBoard } from "./board.js";
import type { RouterDeps } from "./router.js";
import { sendThreadMessage } from "./thread-target.js";

vi.mock("./taught-skills.js", () => ({ assertTeachingSendAllowed: vi.fn() }));
vi.mock("./thread-target.js", () => ({
  resolveThreadTarget: vi.fn(async () => ({ kind: "bot", botId: "builder", threadId: "thread" })),
  sendThreadMessage: vi.fn(async () => ({ runId: "run" })),
}));
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const item = WorkItemSchema.parse({
    id: "board-a",
    title: "Build view",
    description: "Show work",
    acceptanceCriteria: "All columns render",
    type: "task",
    status: "open",
    priority: 1,
    assignee: null,
    labels: [],
    parent: null,
    dependencies: [],
    dueAt: null,
    deferUntil: null,
    estimateMinutes: null,
    externalRef: null,
    createdAt: "",
    updatedAt: "",
    closedAt: null,
    commentCount: 0,
    comments: [],
    history: [],
    closeWhenDone: false,
  });
  const provider = {
    show: vi.fn(async () => item),
    update: vi.fn(async () => item),
    list: vi.fn(async () => [item]),
    ready: vi.fn(async () => [item]),
    blocked: vi.fn(async () => []),
    search: vi.fn(async () => []),
  };
  vi.spyOn(BoardService.prototype, "actor").mockResolvedValue("bot:Builder");
  vi.spyOn(BoardService.prototype, "workspace").mockResolvedValue({ id: "workspace" } as never);
  vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(provider as never);
  const prisma = {
    run: { findFirst: vi.fn(async () => null) },
    bot: { findUniqueOrThrow: vi.fn(async () => ({ name: "Builder" })) },
  };
  const deps = { prisma, dataDir: "/fixture/app" } as unknown as RouterDeps;
  return { item, provider, prisma, board: createBoard(deps) };
}
const actor = { userId: "owner", spaceId: "space" } as Actor;
const input = { workspaceId: "workspace", id: "board-a", botId: "builder", clientNonce: "click" };
it("sends title, description and acceptance criteria through the normal turn with durable board metadata", async () => {
  const { board, provider } = fixture();
  expect(await board.send(actor, input)).toEqual({ runId: "run", botId: "builder" });
  expect(provider.update).toHaveBeenCalledWith("board-a", {
    assignee: "bot:Builder",
    status: "in_progress",
  });
  expect(sendThreadMessage).toHaveBeenCalledWith(
    expect.anything(),
    actor,
    expect.objectContaining({ kind: "bot" }),
    expect.objectContaining({
      text: "Build view\n\nShow work\n\nAcceptance criteria:\nAll columns render\n\nBoard item: board-a",
      board: { workspaceId: "workspace", itemId: "board-a", closeWhenDone: false },
      clientNonce: "board:workspace:board-a:click",
    }),
  );
});
it("replays a send nonce and refuses closed items and a busy bot", async () => {
  const { board, provider, prisma, item } = fixture();
  prisma.run.findFirst.mockResolvedValueOnce({ id: "saved-run" } as never);
  expect(await board.send(actor, input)).toEqual({ runId: "saved-run", botId: "builder" });
  expect(provider.update).not.toHaveBeenCalled();
  item.status = "closed";
  await expect(board.send(actor, input)).rejects.toThrow("closed");
  item.status = "open";
  prisma.run.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "active" } as never);
  await expect(board.send(actor, input)).rejects.toThrow("already working");
});
it("restores assignment if turn creation fails and intersects search with filters", async () => {
  const { board, provider } = fixture();
  vi.mocked(sendThreadMessage).mockRejectedValueOnce(new Error("turn rejected"));
  await expect(board.send(actor, input)).rejects.toThrow("turn rejected");
  expect(provider.update).toHaveBeenLastCalledWith("board-a", { assignee: "", status: "open" });
  expect(
    await board.snapshot(actor, {
      workspaceId: "workspace",
      filter: { label: "backend" },
      search: "none",
    }),
  ).toMatchObject({ items: [], readyIds: ["board-a"] });
  expect(provider.list).toHaveBeenCalledWith();
});

it("serves one whole-board snapshot with at most one selected item and no per-item queries", async () => {
  const { board, provider, item, prisma } = fixture();
  vi.spyOn(BoardService.prototype, "configured").mockResolvedValue([
    {
      id: "workspace",
      enabled: true,
      initialized: true,
      isDefault: true,
      allowAllBots: true,
    } as never,
  ]);
  Object.assign(prisma, { boardFollow: { findMany: vi.fn(async () => [{ itemId: "board-a" }]) } });
  Object.assign(prisma.bot, { findMany: vi.fn(async () => [{ id: "builder", name: "Builder" }]) });
  provider.list.mockResolvedValue(
    Array.from({ length: 100 }, (_, index) => ({ ...item, id: `item-${index}` })),
  );
  const result = await board.view(actor, { itemId: "board-a" });
  expect(result.snapshot.items).toHaveLength(100);
  expect(result.followingIds).toEqual(["board-a"]);
  expect(provider.list).toHaveBeenCalledTimes(1);
  expect(provider.ready).toHaveBeenCalledTimes(1);
  expect(provider.blocked).toHaveBeenCalledTimes(1);
  expect(provider.show).toHaveBeenCalledTimes(1);
});
it("preserves the snapshot and reports only the selected-item failure for a stale deep link", async () => {
  const { board, provider, prisma, item } = fixture();
  vi.spyOn(BoardService.prototype, "configured").mockResolvedValue([
    { id: "workspace", initialized: true, enabled: true, allowAllBots: true } as never,
  ]);
  Object.assign(prisma, { boardFollow: { findMany: vi.fn(async () => []) } });
  Object.assign(prisma.bot, { findMany: vi.fn(async () => []) });
  provider.show.mockRejectedValue(
    new BoardError({ code: "command_failed", message: "Item not found" }),
  );
  const result = await board.view(actor, { workspaceId: "workspace", itemId: "deleted" });
  expect(result.snapshot.items).toEqual([item]);
  expect(result.selected).toBeNull();
  expect(result.problem).toBeNull();
  expect(result).toMatchObject({ selectionProblem: { code: "command_failed" } });
  provider.show.mockClear();
  const cleared = await board.view(actor, { workspaceId: "workspace" });
  expect(cleared.snapshot.items).toEqual([item]);
  expect(provider.show).not.toHaveBeenCalled();
});
it("persists only the acting user's follow and authorizes before reading or writing it", async () => {
  const { board, prisma } = fixture();
  const follows = { upsert: vi.fn(), deleteMany: vi.fn() };
  Object.assign(prisma, { boardFollow: follows });
  await board.follow(actor, { workspaceId: "workspace", id: "board-a", following: true });
  expect(follows.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        workspaceId_itemId_userId: { workspaceId: "workspace", itemId: "board-a", userId: "owner" },
      },
      update: {},
    }),
  );
  await board.follow(actor, { workspaceId: "workspace", id: "board-a", following: false });
  expect(follows.deleteMany).toHaveBeenCalledWith({
    where: { workspaceId: "workspace", itemId: "board-a", userId: "owner" },
  });
  vi.mocked(BoardService.prototype.provider).mockRejectedValueOnce(new Error("forbidden"));
  await expect(
    board.follow(
      { ...actor, userId: "other" },
      { workspaceId: "workspace", id: "board-a", following: true },
    ),
  ).rejects.toThrow("forbidden");
  expect(follows.upsert).toHaveBeenCalledTimes(1);
});
it("checks board-specific bot permission before dispatch", async () => {
  const { board, provider } = fixture();
  vi.mocked(BoardService.prototype.workspace).mockRejectedValueOnce(
    new Error("This bot is not allowed on this board."),
  );
  await expect(board.send(actor, input)).rejects.toThrow("not allowed");
  expect(provider.update).not.toHaveBeenCalled();
});
it("projects default-board Work counts and at most three prioritized ready items from one summary", async () => {
  const { board, item } = fixture();
  const ready = Array.from({ length: 5 }, (_, index) => ({
    ...item,
    id: `ready-${index}`,
    priority: 4 - index,
  }));
  const summary = vi.spyOn(board, "view").mockResolvedValue({
    workspaces: [{ id: "workspace", name: "Work" }] as never,
    workspaceId: "workspace",
    selected: null,
    followingIds: [],
    bots: [],
    problem: null,
    snapshot: {
      items: [
        ...ready,
        { ...item, id: "working", status: "in_progress" },
        { ...item, id: "blocked", status: "blocked" },
      ],
      readyIds: ready.map((row) => row.id),
      blockedIds: ["blocked"],
    },
  });
  const result = await board.work(actor);
  expect(summary).toHaveBeenCalledExactlyOnceWith(actor, {});
  expect(result).toMatchObject({
    workspace: { id: "workspace" },
    ready: 5,
    inProgress: 1,
    blocked: 1,
  });
  expect(result.items.map((row) => row.id)).toEqual(["ready-4", "ready-3", "ready-2"]);
});
