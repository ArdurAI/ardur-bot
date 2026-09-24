import { setTimeout } from "node:timers/promises";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { BoardRun, BoardRunResult } from "@ardurbot/contracts/board";
import { BoardError, BoardRunResultSchema, BoardRunSchema } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import type { BoardScope } from "./service.js";
import { BoardService } from "./service.js";

/** Human source-mode requests execute in the worker, using its login environment. */
export async function requestBoardCommand(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  request: BoardRun,
  scope: BoardScope,
): Promise<BoardRunResult> {
  const signal = AbortSignal.any([
    ...(scope.signal ? [scope.signal] : []),
    AbortSignal.timeout(35_000),
  ]);
  signal.throwIfAborted();
  await deps.prisma.boardCommand.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 60_000) } },
  });
  const row = await deps.prisma.boardCommand.create({
    data: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      request: BoardRunSchema.parse(request),
      expiresAt: new Date(Date.now() + 35_000),
    },
  });
  try {
    await deps.jobs.enqueue({
      name: "board.run",
      payload: { requestId: row.id },
      replaceKey: `board:${row.id}`,
    });
    while (!signal.aborted) {
      const result = await deps.prisma.boardCommand.findUnique({ where: { id: row.id } });
      if (result?.result) return BoardRunResultSchema.parse(result.result);
      await setTimeout(100, undefined, { signal });
    }
    throw new BoardError({ code: "timeout", message: "The board command timed out." });
  } catch (error) {
    if (signal.aborted)
      return { ok: false, problem: { code: "timeout", message: "The board command timed out." } };
    throw error;
  } finally {
    await deps.prisma.boardCommand.deleteMany({ where: { id: row.id } });
  }
}

export async function executeBoardCommand(
  deps: { prisma: PrismaClient; dataDir: string },
  requestId: string,
) {
  const claimed = await deps.prisma.boardCommand.updateMany({
    where: { id: requestId, status: "queued", expiresAt: { gt: new Date() } },
    data: { status: "running" },
  });
  // A job retry must never repeat a potentially completed mutation.
  if (!claimed.count) return;
  const row = await deps.prisma.boardCommand.findUnique({ where: { id: requestId } });
  if (!row) return;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(Math.max(1, row.expiresAt.getTime() - Date.now())),
  ]);
  const timer = setInterval(() => {
    void deps.prisma.boardCommand
      .findUnique({ where: { id: requestId }, select: { id: true } })
      .then((active) => {
        if (!active) controller.abort();
      })
      .catch(() => controller.abort());
  }, 250);
  let result: BoardRunResult;
  try {
    const input = BoardRunSchema.parse(row.request);
    const scope = { userId: row.userId, spaceId: row.spaceId, signal };
    const service = new BoardService(deps);
    if (input.action !== "discover") {
      const workspace = await service.workspace(scope, input.workspaceId);
      if (
        input.workspace?.kind !== workspace.kind ||
        (input.workspace.kind === "folder" && input.workspace.path !== workspace.path) ||
        (input.action === "init" && input.prefix !== workspace.prefix)
      )
        throw new BoardError({
          code: "forbidden",
          message: "This board is not available in this space.",
        });
    }
    result = await service.run(input, scope);
  } catch (error) {
    result = {
      ok: false,
      problem:
        error instanceof BoardError
          ? error.problem
          : {
              code: "command_failed",
              message: "The board is unavailable. Check this computer and its registered folders.",
            },
    };
  } finally {
    clearInterval(timer);
  }
  await deps.prisma.boardCommand.updateMany({
    where: { id: requestId, status: "running" },
    data: { status: "finished", result },
  });
}
