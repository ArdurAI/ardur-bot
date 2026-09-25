import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { parseBeadsItem } from "./beads.js";
import { BoardService } from "./service.js";
import { executeBoardTool, finishBoardRun } from "./tools.js";

afterEach(() => vi.restoreAllMocks());
const scope = { userId: "owner", spaceId: "space", botId: "builder", runId: "run" };
function fixture() {
  const workspace = {
    id: "workspace",
    spaceId: "space",
    ownerUserId: "owner",
    kind: "space",
    path: "/fixture/board/space",
    prefix: "board",
    enabled: true,
    initialized: true,
    name: null,
    isDefault: true,
    allowAllBots: true,
    allowedBotIds: [] as string[],
  };
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "owner", computerHost: "this-mac" })),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ userId: "owner" })) },
    user: { findUniqueOrThrow: vi.fn(async () => ({ name: "Board owner" })) },
    bot: {
      findFirst: vi.fn(async () => ({
        name: "Builder",
        computer: { kind: "desktop", connectionId: null },
      })),
    },
    boardFollow: { findMany: vi.fn(async () => []) },
    boardWorkspace: { findFirst: vi.fn(async () => workspace) },
    run: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const service = new BoardService({
    prisma: prisma as unknown as PrismaClient,
    dataDir: "/fixture/app",
  });
  return { prisma, service, workspace };
}
it("binds actor and workspace lookup to the owner, space and bot computer", async () => {
  const { prisma, service } = fixture();
  expect(await service.actor({ userId: "owner", spaceId: "space" })).toBe("Board owner");
  expect(await service.actor(scope)).toBe("bot:Builder");
  await service.provider(scope, "workspace");
  expect(prisma.boardWorkspace.findFirst).toHaveBeenCalledWith({
    where: { id: "workspace", spaceId: "space", ownerUserId: "owner", enabled: true },
  });
  expect(prisma.bot.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "builder", spaceId: "space", userId: "owner", archivedAt: null },
    }),
  );
  prisma.boardWorkspace.findFirst.mockResolvedValueOnce(null as never);
  await expect(service.provider(scope, "other-space-board")).rejects.toMatchObject({
    problem: { code: "no_board" },
  });
  prisma.spaceMember.findUnique.mockResolvedValueOnce(null as never);
  await expect(service.actor(scope)).rejects.toMatchObject({ problem: { code: "forbidden" } });
  prisma.deploymentSettings.findUnique.mockResolvedValueOnce({
    ownerUserId: "someone-else",
    computerHost: "this-mac",
  });
  await expect(service.actor(scope)).rejects.toMatchObject({ problem: { code: "forbidden" } });
  prisma.bot.findFirst.mockResolvedValueOnce({
    name: "Builder",
    computer: { kind: "remote", connectionId: "remote" },
  } as never);
  await expect(service.actor(scope)).rejects.toMatchObject({ problem: { code: "forbidden" } });
  await expect(service.start(scope, "workspace")).rejects.toThrow("app");
});
it("prevents close and status-update bypasses when the dispatched item stays a human action", async () => {
  const { prisma, service } = fixture();
  prisma.run.findFirst.mockResolvedValue({
    boardItemId: "board-a",
    boardWorkspaceId: "workspace",
    boardCloseWhenDone: false,
  });
  const provider = {
    show: vi.fn(async () => parseBeadsItem({ id: "board-a", title: "Task" })),
    close: vi.fn(),
    update: vi.fn(),
  };
  vi.spyOn(service, "provider").mockResolvedValue(provider as never);
  await expect(
    executeBoardTool(service, scope, "board_close", {
      workspaceId: "workspace",
      ids: ["board-a"],
      reason: "Done",
    }),
  ).rejects.toThrow("human action");
  await expect(
    executeBoardTool(service, scope, "board_update", {
      workspaceId: "workspace",
      id: "board-a",
      patch: { status: "closed" },
    }),
  ).rejects.toThrow("human action");
  expect(provider.close).not.toHaveBeenCalled();
  expect(provider.update).not.toHaveBeenCalled();
});
it("shows a folder-dispatched item when the tool omits its workspace", async () => {
  const { prisma, service, workspace } = fixture();
  prisma.run.findFirst.mockResolvedValue({ boardWorkspaceId: "folder" });
  prisma.boardWorkspace.findFirst.mockImplementation(async (input?: unknown) => {
    const { where } = input as { where: { id?: string } };
    return where.id === "folder"
      ? { ...workspace, id: "folder", kind: "folder", path: "/fixture/project" }
      : workspace;
  });
  const transport = vi.spyOn(service, "run").mockImplementation(async (request) => ({
    ok: true,
    stdout: JSON.stringify(
      request.workspaceId === "folder" && request.argv[0] === "show"
        ? [{ id: "project-a", title: "Folder task" }]
        : [],
    ),
  }));
  await expect(
    executeBoardTool(service, scope, "board_show", { id: "project-a" }),
  ).resolves.toMatchObject({ id: "project-a", title: "Folder task" });
  expect(prisma.run.findFirst).toHaveBeenCalledWith({
    where: { id: scope.runId, spaceId: scope.spaceId, userId: scope.userId, botId: scope.botId },
    select: { boardWorkspaceId: true },
  });
  expect(transport).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "folder",
      workspace: { kind: "folder", path: "/fixture/project" },
    }),
    scope,
  );
});
it.each(["running", "queued"])("does not publish a Board outcome for a %s run", async (status) => {
  const { prisma } = fixture();
  prisma.run.findUnique.mockResolvedValue({
    id: scope.runId,
    ...scope,
    status,
    boardItemId: "board-a",
    boardWorkspaceId: "workspace",
  });
  const provider = vi.spyOn(BoardService.prototype, "provider").mockResolvedValue({
    show: vi.fn(async () => parseBeadsItem({ id: "board-a", title: "Task" })),
    comment: vi.fn(),
    close: vi.fn(),
  } as never);
  await finishBoardRun({ prisma: prisma as unknown as PrismaClient }, scope, "Done");
  expect(provider).not.toHaveBeenCalled();
  expect(prisma.run.update).not.toHaveBeenCalled();
});
it.each(["cancelled", "failed"])(
  "uses persisted %s status for the Board outcome",
  async (status) => {
    const { prisma } = fixture();
    prisma.run.findUnique.mockResolvedValue({
      id: scope.runId,
      ...scope,
      status,
      boardItemId: "board-a",
      boardWorkspaceId: "workspace",
      boardCloseWhenDone: true,
    });
    const provider = {
      show: vi.fn(async () =>
        parseBeadsItem({ id: "board-a", title: "Task", metadata: { ardur_close_when_done: true } }),
      ),
      comment: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(provider as never);
    await finishBoardRun({ prisma: prisma as unknown as PrismaClient }, scope, "Outcome");
    expect(provider.comment).toHaveBeenCalledWith(
      "board-a",
      `[Run run] ${status === "cancelled" ? "Cancelled" : "Failed"}\nOutcome`,
    );
    expect(provider.close).not.toHaveBeenCalled();
  },
);
it("records an outcome once and closes only with both saved and current permission", async () => {
  const { prisma } = fixture();
  const run = {
    id: "run",
    ...scope,
    boardItemId: "board-a",
    boardWorkspaceId: "workspace",
    boardCloseWhenDone: false,
    boardCommentedAt: null,
    status: "completed",
  };
  prisma.run.findUnique.mockResolvedValue(run);
  const item = parseBeadsItem({
    id: "board-a",
    title: "Task",
    metadata: { ardur_close_when_done: true },
  });
  const provider = { show: vi.fn(async () => item), comment: vi.fn(), close: vi.fn() };
  vi.spyOn(BoardService.prototype, "provider").mockResolvedValue(provider as never);
  const deps = { prisma: prisma as unknown as PrismaClient };
  await finishBoardRun(deps, scope, "Checks passed");
  expect(provider.comment).toHaveBeenCalledWith("board-a", "[Run run] Completed\nChecks passed");
  expect(provider.close).not.toHaveBeenCalled();
  run.boardCloseWhenDone = true;
  item.comments.push({
    id: "comment",
    author: "bot:Builder",
    text: "[Run run] Completed\nChecks passed",
    createdAt: "2026-01-01T00:00:00Z",
  });
  await finishBoardRun(deps, scope, "Checks passed");
  expect(provider.comment).toHaveBeenCalledTimes(1);
  expect(provider.close).toHaveBeenCalledWith(["board-a"], "Bot reported done");
  item.closeWhenDone = false;
  provider.close.mockClear();
  await finishBoardRun(deps, scope, "Checks passed");
  expect(provider.close).not.toHaveBeenCalled();
  await expect(finishBoardRun(deps, { ...scope, spaceId: "foreign" }, "")).rejects.toThrow("space");
});

it("rejects bot access outside the configured board allowlist", async () => {
  const { service, workspace } = fixture();
  workspace.allowAllBots = false;
  await expect(service.provider(scope, "workspace")).rejects.toThrow("not allowed");
  workspace.allowedBotIds.push(scope.botId);
  await expect(service.workspace(scope, "workspace")).resolves.toMatchObject({ id: "workspace" });
});
it("uses an initialized folder as the default when the space board has not been started", async () => {
  const { service, prisma, workspace } = fixture();
  const rows = [
    { ...workspace, initialized: false, isDefault: false },
    { ...workspace, id: "folder", kind: "folder", path: "/fixture/project", isDefault: false },
  ];
  prisma.boardWorkspace.findFirst.mockImplementation(async (input?: unknown) => {
    const { where } = input as { where: Record<string, unknown> };
    return (
      rows.find((row) =>
        Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
      ) ?? (null as never)
    );
  });
  expect(await service.workspace(scope)).toMatchObject({ id: "folder", initialized: true });
});
it("discovers uninitialized boards without creating their Beads files", async () => {
  const { prisma, service, workspace } = fixture();
  const uninitialized = { ...workspace, initialized: false, name: "Board" };
  Object.assign(prisma, { space: { findUniqueOrThrow: vi.fn(async () => ({ name: "Space" })) } });
  Object.assign(prisma.boardWorkspace, { upsert: vi.fn(async () => uninitialized) });
  const run = vi
    .spyOn(service, "run")
    .mockResolvedValue({ ok: true, workspaces: [{ ...uninitialized, kind: "space" }] });
  expect(await service.workspaces({ userId: "owner", spaceId: "space" })).toMatchObject({
    workspaces: [{ initialized: false }],
    problem: null,
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].action).toBe("discover");
});
it("requires owner and scope for configuration, and serializes default changes", async () => {
  const { prisma, service, workspace } = fixture();
  const update = vi.fn(async ({ data }: { data: object }) => ({ ...workspace, ...data }));
  const updateMany = vi.fn();
  const lock = vi.fn();
  Object.assign(prisma, {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ $queryRaw: lock, boardWorkspace: { update, updateMany } }),
    ),
  });
  await service.configure({ userId: "owner", spaceId: "space" }, "workspace", {
    isDefault: true,
    name: "Planning",
  });
  expect(lock).toHaveBeenCalled();
  expect(updateMany).toHaveBeenCalledWith({
    where: { spaceId: "space", ownerUserId: "owner", isDefault: true },
    data: { isDefault: false },
  });
  await service.configure({ userId: "owner", spaceId: "space" }, "workspace", { enabled: false });
  expect(update).toHaveBeenLastCalledWith({
    where: { id: "workspace" },
    data: { enabled: false, isDefault: false },
  });
  prisma.boardWorkspace.findFirst.mockResolvedValueOnce(null as never);
  await expect(
    service.configure({ userId: "owner", spaceId: "space" }, "foreign", { name: "Changed" }),
  ).rejects.toThrow("unavailable");
  await expect(service.configure(scope, "workspace", { name: "Changed" })).rejects.toThrow(
    "Settings",
  );
});
