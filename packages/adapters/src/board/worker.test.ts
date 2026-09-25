import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { BoardService } from "./service.js";
import { executeBoardCommand, requestBoardCommand } from "./worker.js";

afterEach(() => vi.restoreAllMocks());
const request = {
  action: "command" as const,
  actor: "Owner",
  workspaceId: "workspace",
  workspace: { kind: "space" as const },
  argv: ["ready"],
};
function fixture() {
  const row = {
    id: "request",
    userId: "owner",
    spaceId: "space",
    request,
    result: null as unknown,
    status: "queued",
    expiresAt: new Date(Date.now() + 30_000),
  };
  const prisma = {
    boardCommand: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => row),
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status !== row.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  const deps = { prisma: prisma as unknown as PrismaClient, dataDir: "/fixture/app" };
  vi.spyOn(BoardService.prototype, "workspace").mockResolvedValue({
    spaceId: "space",
    ownerUserId: "owner",
    createdAt: new Date(),
    updatedAt: new Date(),
    id: "workspace",
    kind: "space",
    path: "/fixture/board",
    prefix: "board",
    name: "Board",
    enabled: true,
    initialized: true,
    isDefault: true,
    allowAllBots: true,
    allowedBotIds: [],
  });
  const run = vi.spyOn(BoardService.prototype, "run").mockResolvedValue({ ok: true, stdout: "[]" });
  return { row, prisma, deps, run };
}
it("runs a source-mode request in the worker once and deletes the transient response", async () => {
  const { deps, prisma, run } = fixture();
  const enqueue = vi.fn(async () => executeBoardCommand(deps, "request"));
  const result = await requestBoardCommand(
    { ...deps, jobs: { enqueue } as unknown as JobPublisher },
    request,
    { userId: "owner", spaceId: "space" },
  );
  expect(result).toEqual({ ok: true, stdout: "[]" });
  expect(enqueue).toHaveBeenCalledWith({
    name: "board.run",
    payload: { requestId: "request" },
    replaceKey: "board:request",
  });
  expect(run).toHaveBeenCalledWith(
    request,
    expect.objectContaining({ userId: "owner", spaceId: "space", signal: expect.any(AbortSignal) }),
  );
  await executeBoardCommand(deps, "request");
  expect(run).toHaveBeenCalledTimes(1);
  expect(prisma.boardCommand.deleteMany).toHaveBeenLastCalledWith({ where: { id: "request" } });
});
it("revalidates folder identity in the worker before calling bd", async () => {
  const { deps, row, run } = fixture();
  row.request = { ...request, workspace: { kind: "folder", path: "/outside" } } as never;
  await executeBoardCommand(deps, "request");
  expect(run).not.toHaveBeenCalled();
  expect(row.result).toMatchObject({ ok: false, problem: { code: "forbidden" } });
});
it.each(["space", "folder"])(
  "initializes a discovered %s workspace through the source worker",
  async (kind) => {
    const { deps, row, prisma, run } = fixture();
    vi.mocked(BoardService.prototype.workspace).mockRestore();
    const workspace = {
      id: "workspace",
      kind,
      path: "/fixture/project",
      prefix: "board",
      name: "Board",
      initialized: false,
      enabled: true,
      isDefault: false,
      allowAllBots: true,
      allowedBotIds: [],
    };
    Object.assign(prisma, {
      deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
      spaceMember: { findUnique: vi.fn(async () => ({ userId: "owner" })) },
      user: { findUniqueOrThrow: vi.fn(async () => ({ name: "Owner" })) },
      boardWorkspace: { findFirst: vi.fn(async () => workspace) },
    });
    row.request = {
      ...request,
      action: "init",
      prefix: "board",
      argv: [],
      workspace: kind === "space" ? { kind } : { kind, path: workspace.path },
    } as never;
    await executeBoardCommand(deps, "request");
    expect(row.result).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledWith(
      row.request,
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
    );
  },
);
it("cancels a queued source request without replaying a mutation", async () => {
  const { deps, prisma } = fixture();
  const controller = new AbortController();
  const jobs = { enqueue: vi.fn(async () => controller.abort()) } as unknown as JobPublisher;
  expect(
    await requestBoardCommand({ ...deps, jobs }, request, {
      userId: "owner",
      spaceId: "space",
      signal: controller.signal,
    }),
  ).toMatchObject({ ok: false, problem: { code: "timeout" } });
  expect(prisma.boardCommand.deleteMany).toHaveBeenLastCalledWith({ where: { id: "request" } });
});
