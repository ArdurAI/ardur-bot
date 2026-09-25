import { BoardService, requestBoardCommand } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { BoardFilter, BoardSnapshot } from "@ardurbot/contracts/board";
import { BoardError, BoardPatchSchema } from "@ardurbot/contracts/board";
import { ACTIVE_RUN_STATUSES } from "@ardurbot/core";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";
import { assertTeachingSendAllowed } from "./taught-skills.js";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

export async function boardCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BoardError)
      throw new ORPCError(error.problem.code === "forbidden" ? "FORBIDDEN" : "BAD_REQUEST", {
        message: error.message,
        data: error.problem,
      });
    throw error;
  }
}
export function createBoard(deps: RouterDeps) {
  const pendingSends = new Set<string>();
  const service = new BoardService({
    prisma: deps.prisma,
    dataDir: deps.dataDir,
    localRun: (request, scope) => requestBoardCommand(deps, request, scope),
    ownerRun: (request, scope) => {
      if (!deps.hostBridge)
        throw new BoardError({
          code: "command_failed",
          message: "Open the desktop app to use this board.",
        });
      return deps.hostBridge.runBoard(request, scope);
    },
  });
  return {
    service,
    async snapshot(
      actor: Actor,
      input: { workspaceId: string; filter?: BoardFilter; search?: string },
    ): Promise<BoardSnapshot> {
      const provider = await service.provider(actor, input.workspaceId);
      const allItems = await provider.list();
      const items = allItems.filter((item) =>
        Object.entries(input.filter ?? {}).every(
          ([key, value]) =>
            value === undefined ||
            (key === "label"
              ? item.labels.includes(value)
              : item[key as "type" | "assignee" | "parent" | "status"] === value),
        ),
      );
      const ready = await provider.ready(input.filter);
      const blocked = await provider.blocked();
      const matches = input.search
        ? new Set((await provider.search(input.search)).map((item) => item.id))
        : null;
      return {
        items: matches ? items.filter((item) => matches.has(item.id)) : items,
        allItems,
        readyIds: ready.map((item) => item.id),
        blockedIds: blocked.map((item) => item.id),
      };
    },
    async send(
      actor: Actor,
      input: { workspaceId: string; id: string; botId: string; clientNonce: string },
    ) {
      const key = `${actor.spaceId}:${input.workspaceId}:${input.id}`;
      if (pendingSends.has(key))
        throw new ORPCError("CONFLICT", { message: "This item is already being sent." });
      pendingSends.add(key);
      try {
        await service.actor({ ...actor, botId: input.botId });
        await assertTeachingSendAllowed(deps.prisma, actor.spaceId, input.botId);
        const nonce = `board:${input.workspaceId}:${input.id}:${input.clientNonce}`;
        const existing = await deps.prisma.run.findFirst({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: input.botId,
            boardWorkspaceId: input.workspaceId,
            boardItemId: input.id,
            sourceMessage: { clientNonce: nonce },
          },
        });
        if (existing) return { runId: existing.id, botId: input.botId };
        if (
          await deps.prisma.run.findFirst({
            where: {
              spaceId: actor.spaceId,
              OR: [
                { botId: input.botId },
                { boardWorkspaceId: input.workspaceId, boardItemId: input.id },
              ],
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
          })
        )
          throw new ORPCError("CONFLICT", {
            message: "This bot is already working. Try again when it finishes.",
          });
        const provider = await service.provider(actor, input.workspaceId);
        const item = await provider.show(input.id);
        if (item.status === "closed")
          throw new ORPCError("CONFLICT", { message: "This work item is already closed." });
        const target = await resolveThreadTarget(deps.prisma, actor, { botId: input.botId });
        if (target.kind !== "bot") throw new ORPCError("FORBIDDEN");
        const bot = await deps.prisma.bot.findUniqueOrThrow({
          where: { id: input.botId },
          select: { name: true },
        });
        await provider.update(item.id, { assignee: `bot:${bot.name}`, status: "in_progress" });
        try {
          const result = await sendThreadMessage(deps, actor, target, {
            text: `${item.title}\n\n${item.description}\n\nAcceptance criteria:\n${item.acceptanceCriteria}\n\nBoard item: ${item.id}`,
            clientNonce: nonce,
            board: {
              workspaceId: input.workspaceId,
              itemId: item.id,
              closeWhenDone: item.closeWhenDone,
            },
          });
          return { runId: result.runId, botId: input.botId };
        } catch (error) {
          // Queue delivery may fail after the transaction commits; the reconciler owns that run.
          const committed = await deps.prisma.run.findFirst({
            where: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: input.botId,
              boardWorkspaceId: input.workspaceId,
              boardItemId: input.id,
              sourceMessage: { clientNonce: nonce },
            },
          });
          if (committed) return { runId: committed.id, botId: input.botId };
          const previousStatus = BoardPatchSchema.shape.status.safeParse(item.status);
          await provider
            .update(item.id, {
              assignee: item.assignee ?? "",
              ...(previousStatus.success ? { status: previousStatus.data } : {}),
            })
            .catch(() => undefined);
          throw error;
        }
      } finally {
        pendingSends.delete(key);
      }
    },
  };
}
