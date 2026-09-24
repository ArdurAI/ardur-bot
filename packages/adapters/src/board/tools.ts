import type { ConnectorTool } from "@ardurbot/adapter-kit";
import {
  BOARD_LINK_TYPES,
  BoardCreateSchema,
  BoardError,
  BoardFilterSchema,
  BoardItemIdSchema,
  BoardPatchSchema,
} from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { z } from "zod";
import type { BoardScope } from "./service.js";
import { BoardService } from "./service.js";

const workspace = z.object({ workspaceId: z.string().optional() });
const item = workspace.extend({ id: BoardItemIdSchema });
export const boardToolSchemas = {
  board_ready: workspace.extend({ filter: BoardFilterSchema.optional() }),
  board_show: item,
  board_create: workspace.extend({ item: BoardCreateSchema.omit({ closeWhenDone: true }) }),
  board_update: item.extend({ patch: BoardPatchSchema.omit({ closeWhenDone: true }) }),
  board_claim: workspace.extend({
    id: BoardItemIdSchema.optional(),
    filter: BoardFilterSchema.optional(),
  }),
  board_close: workspace.extend({
    ids: z.array(BoardItemIdSchema).min(1).max(50),
    reason: z.string().max(32_000),
  }),
  board_comment: item.extend({ text: z.string().min(1).max(32_000) }),
  board_link: workspace.extend({
    from: BoardItemIdSchema,
    to: BoardItemIdSchema,
    type: z.enum(BOARD_LINK_TYPES),
  }),
};
const descriptions: Record<keyof typeof boardToolSchemas, string> = {
  board_ready:
    "List open work without active blockers on this computer. Omit workspaceId for the space board.",
  board_show: "Read a board item, acceptance criteria, dependencies and comments.",
  board_create: "Create a work item. Dependencies identify prerequisites for the new item.",
  board_update: "Update a work item on this computer's board.",
  board_claim: "Atomically claim an item, or the first ready item matching a filter, as this bot.",
  board_close: "Close work items with a reason when asked to close them.",
  board_comment: "Record an outcome or question on a work item.",
  board_link: "Link from a dependent item to its prerequisite; blocks means from is blocked by to.",
};
export const boardTools: ConnectorTool[] = Object.entries(boardToolSchemas).map(
  ([name, schema]) => ({
    name,
    readOnly: name === "board_ready" || name === "board_show",
    description: descriptions[name as keyof typeof boardToolSchemas],
    inputSchema: z.toJSONSchema(schema),
  }),
);
export const BOARD_TOOL_NAMES = new Set(boardTools.map((tool) => tool.name));
export async function executeBoardTool(
  service: BoardService,
  scope: BoardScope,
  name: string,
  raw: unknown,
) {
  const schema = boardToolSchemas[name as keyof typeof boardToolSchemas];
  if (!schema) throw new Error("Unknown board tool.");
  const input = schema.parse(raw);
  const provider = await service.provider(scope, input.workspaceId);
  switch (name) {
    case "board_ready":
      return { items: await provider.ready(boardToolSchemas.board_ready.parse(raw).filter) };
    case "board_show":
      return provider.show(boardToolSchemas.board_show.parse(raw).id);
    case "board_create":
      return provider.create(boardToolSchemas.board_create.parse(raw).item);
    case "board_update": {
      const args = boardToolSchemas.board_update.parse(raw);
      if (args.patch.status === "closed")
        await service.assertBotMayClose(scope, input.workspaceId, [args.id]);
      return provider.update(args.id, args.patch);
    }
    case "board_claim": {
      const args = boardToolSchemas.board_claim.parse(raw);
      return provider.claim(args.id ?? args.filter ?? {}, await service.actor(scope));
    }
    case "board_close": {
      const args = boardToolSchemas.board_close.parse(raw);
      await service.assertBotMayClose(scope, input.workspaceId, args.ids);
      return provider.close(args.ids, args.reason);
    }
    case "board_comment": {
      const args = boardToolSchemas.board_comment.parse(raw);
      return provider.comment(args.id, args.text);
    }
    case "board_link": {
      const args = boardToolSchemas.board_link.parse(raw);
      await provider.link(args.from, args.to, args.type);
      return { ok: true };
    }
  }
}
/** Called while the run lease is still active, through the same scoped host authorization. */
export async function finishBoardRun(
  deps: { prisma: PrismaClient; dataDir?: string },
  scope: BoardScope & { runId: string },
  outcome: string,
  completed: boolean,
) {
  const run = await deps.prisma.run.findUnique({ where: { id: scope.runId } });
  if (!run?.boardItemId || !run.boardWorkspaceId || run.boardCommentedAt) return;
  if (run.spaceId !== scope.spaceId || run.userId !== scope.userId || run.botId !== scope.botId)
    throw new BoardError({
      code: "forbidden",
      message: "This board is not available in this space.",
    });
  const service = new BoardService({ prisma: deps.prisma, dataDir: deps.dataDir ?? "./data" });
  const provider = await service.provider(scope, run.boardWorkspaceId);
  const item = await provider.show(run.boardItemId);
  const marker = `[Run ${run.id}]`;
  if (!item.comments.some((comment) => comment.text.startsWith(marker)))
    await provider.comment(
      item.id,
      `${marker} ${completed ? "Completed" : run.status === "cancelled" ? "Cancelled" : "Failed"}\n${outcome.slice(0, 30_000)}`,
    );
  if (completed && run.boardCloseWhenDone && item.closeWhenDone && item.status !== "closed")
    await provider.close([item.id], "Bot reported done");
  await deps.prisma.run.update({ where: { id: run.id }, data: { boardCommentedAt: new Date() } });
}
