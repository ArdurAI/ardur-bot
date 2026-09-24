import { BoardService } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { WorkItemSchema } from "@ardurbot/contracts/board";
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
