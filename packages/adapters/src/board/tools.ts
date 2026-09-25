import { randomUUID } from "node:crypto";
import type { ConnectorTool } from "@ardurbot/adapter-kit";
import type { BoardCreate, BoardPatch, WorkItem } from "@ardurbot/contracts/board";
import {
  BOARD_LINK_TYPES,
  BoardClaimFilterSchema,
  BoardCreateSchema,
  BoardDeniedError,
  BoardError,
  BoardFilterSchema,
  BoardItemIdSchema,
  BoardPatchSchema,
} from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { z } from "zod";
import type { BoardScope } from "./service.js";
import { BoardService } from "./service.js";
import {
  alternateBoardSentence,
  BOARD_WRITE_TOOLS,
  type BoardToolAccess,
  type BoardUnavailableReason,
  boardUnavailableSentence,
  duplicateBoardItemMessage,
  filingBotName,
  isBoardUnreachable,
  normalizeBoardTitle,
  redactBoardText,
  withBotFiledLabel,
} from "./upkeep.js";

export type BoardToolRunOptions = {
  upkeep?: boolean;
  secrets?: string[];
  board?: BoardToolAccess;
  reason?: BoardUnavailableReason | null;
};

const workspace = z.object({ workspaceId: z.string().optional() });
const item = workspace.extend({ id: BoardItemIdSchema });
export const boardToolSchemas = {
  board_ready: workspace.extend({ filter: BoardFilterSchema.optional() }),
  board_show: item,
  board_create: workspace.extend({ item: BoardCreateSchema.omit({ closeWhenDone: true }) }),
  board_update: item.extend({ patch: BoardPatchSchema.omit({ closeWhenDone: true }) }),
  board_claim: workspace.extend({
    id: BoardItemIdSchema.optional(),
    filter: BoardClaimFilterSchema.optional(),
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
    "List open work without active blockers on this computer. Omit workspaceId for this run's dispatched board, or the space board otherwise.",
  board_show: "Read a board item, acceptance criteria, dependencies and comments.",
  board_create: "Create a work item. Dependencies identify prerequisites for the new item.",
  board_update: "Update a work item on this computer's board.",
  board_claim:
    "Atomically claim an item, or the first ready item matching a filter, as this bot. Filters cannot include assignee; claim assigned items by ID.",
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
function workspaceIdOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || !("workspaceId" in raw)) return undefined;
  return typeof raw.workspaceId === "string" && raw.workspaceId ? raw.workspaceId : undefined;
}
const REDACTED_TEXT_FIELDS = [
  "title",
  "description",
  "acceptanceCriteria",
  "assignee",
  "externalRef",
] as const;
/** Removes the run's secrets from every persisted text field of a create or patch. */
function redactBoardFields<T extends BoardPatch>(fields: T, secrets: string[]): T {
  const redacted = { ...fields };
  for (const key of REDACTED_TEXT_FIELDS) {
    const value = redacted[key];
    if (typeof value === "string")
      Object.assign(redacted, { [key]: redactBoardText(value, secrets) });
  }
  if (redacted.labels)
    redacted.labels = redacted.labels.map((label) => redactBoardText(label, secrets));
  return redacted;
}
type Provider = Awaited<ReturnType<BoardService["provider"]>>;
async function noteFiling(
  service: BoardService,
  provider: Provider,
  scope: BoardScope,
  item: WorkItem,
) {
  if (!scope.runId || !scope.botId || typeof provider.noteFiling !== "function") return item;
  const actor = await service.actor(scope);
  return provider.noteFiling(item.id, {
    runId: scope.runId,
    botId: scope.botId,
    botName: filingBotName(actor.startsWith("bot:") ? actor.slice(4) : actor),
  });
}
/** Call inside the space's filing lock; no database transaction spans a host command. */
async function fileUpkeepItem(
  service: BoardService,
  provider: Provider,
  scope: BoardScope,
  workspaceId: string,
  item: BoardCreate,
) {
  const title = normalizeBoardTitle(item.title);
  const existing = (await provider.list()).find(
    (row) => row.status !== "closed" && normalizeBoardTitle(row.title) === title,
  );
  if (existing) {
    if (
      !existing.filedBy &&
      (await service.claimHollowFiling(scope, workspaceId, existing.id, title))
    )
      return noteFiling(service, provider, scope, existing);
    const repair = !existing.filedBy && (await service.runFiling(scope, workspaceId, existing.id));
    return {
      item: repair ? await noteFiling(service, provider, scope, existing) : existing,
      duplicate: true,
      message: duplicateBoardItemMessage(existing.id),
    };
  }
  const reserved = await service.reserveBotFiling(scope, title);
  if (!reserved.ok) return { error: reserved.message };
  let created: WorkItem | undefined;
  try {
    created = await provider.create({ ...item, labels: withBotFiledLabel(item.labels) });
    await service.recordFilingItem(reserved.id, workspaceId, created.id);
  } catch (error) {
    await service.settleFailedFiling(reserved.id, workspaceId, error, created?.id);
    throw error;
  }
  return noteFiling(service, provider, scope, created);
}
async function admittedWorkspaceIds(service: BoardService, scope: BoardScope) {
  try {
    return (await service.botBoardChoices(scope)).admitted.map((row) => row.id);
  } catch (error) {
    if (isBoardUnreachable(error)) return "unreachable" as const;
    throw error;
  }
}
async function deniedBoardError(service: BoardService, scope: BoardScope, error: unknown) {
  if (isBoardUnreachable(error)) return { error: boardUnavailableSentence("unreachable") };
  if (!(error instanceof BoardDeniedError)) return null;
  const ids = await admittedWorkspaceIds(service, scope);
  if (ids === "unreachable") return { error: boardUnavailableSentence("unreachable") };
  if (ids.length) return { error: alternateBoardSentence(ids) };
  return null;
}
export async function executeBoardTool(
  service: BoardService,
  scope: BoardScope,
  name: string,
  raw: unknown,
  options: BoardToolRunOptions = {},
) {
  const schema = boardToolSchemas[name as keyof typeof boardToolSchemas];
  if (!schema) throw new Error("Unknown board tool.");
  const blocked =
    Boolean(options.upkeep && options.board && options.board !== "write") &&
    (options.board === "none" || BOARD_WRITE_TOOLS.has(name));
  if (blocked) {
    const reason = options.reason ?? (options.board === "read" ? "read-only" : "no-board");
    if (!(options.board === "none" && reason === "no-board"))
      return { error: boardUnavailableSentence(reason) };
    const requestedId = workspaceIdOf(raw);
    if (!requestedId) {
      const ids = await admittedWorkspaceIds(service, scope);
      if (ids === "unreachable") return { error: boardUnavailableSentence("unreachable") };
      if (ids.length) return { error: alternateBoardSentence(ids) };
      return { error: boardUnavailableSentence("no-board") };
    }
    try {
      await service.workspace(scope, requestedId);
    } catch (error) {
      const hinted = await deniedBoardError(service, scope, error);
      if (hinted) return hinted;
      if (!(error instanceof BoardError)) throw error;
      return { error: boardUnavailableSentence("no-board") };
    }
  }
  const input = schema.parse(raw);
  const secrets = options.secrets ?? [];
  let provider: Awaited<ReturnType<BoardService["provider"]>>;
  try {
    provider = await service.provider(scope, input.workspaceId);
  } catch (error) {
    const hinted = await deniedBoardError(service, scope, error);
    if (hinted) return hinted;
    throw error;
  }
  switch (name) {
    case "board_ready":
      return { items: await provider.ready(boardToolSchemas.board_ready.parse(raw).filter) };
    case "board_show":
      return provider.show(boardToolSchemas.board_show.parse(raw).id);
    case "board_create": {
      const args = boardToolSchemas.board_create.parse(raw);
      const item = redactBoardFields(args.item, secrets);
      if (!options.upkeep) return provider.create(item);
      const workspaceId = (await service.workspace(scope, args.workspaceId)).id;
      return service.withFilingLock(scope, () =>
        fileUpkeepItem(service, provider, scope, workspaceId, item),
      );
    }
    case "board_update": {
      const args = boardToolSchemas.board_update.parse(raw);
      if (args.patch.status === "closed")
        await service.assertBotMayClose(scope, input.workspaceId, [args.id]);
      return provider.update(args.id, redactBoardFields(args.patch, secrets));
    }
    case "board_claim": {
      const args = boardToolSchemas.board_claim.parse(raw);
      return provider.claim(args.id ?? args.filter ?? {}, await service.actor(scope));
    }
    case "board_close": {
      const args = boardToolSchemas.board_close.parse(raw);
      await service.assertBotMayClose(scope, input.workspaceId, args.ids);
      return provider.close(args.ids, redactBoardText(args.reason, secrets));
    }
    case "board_comment": {
      const args = boardToolSchemas.board_comment.parse(raw);
      return provider.comment(args.id, redactBoardText(args.text, secrets));
    }
    case "board_link": {
      const args = boardToolSchemas.board_link.parse(raw);
      await provider.link(args.from, args.to, args.type);
      return { ok: true };
    }
  }
}
/** Deliver only persisted terminal outcomes, through the scoped host outcome authorization. */
export async function finishBoardRun(
  deps: { prisma: PrismaClient; dataDir?: string },
  scope: BoardScope & { runId: string },
  outcome: string,
) {
  const run = await deps.prisma.run.findUnique({ where: { id: scope.runId } });
  if (!run?.boardItemId || !run.boardWorkspaceId || run.boardCommentedAt) return;
  if (run.spaceId !== scope.spaceId || run.userId !== scope.userId || run.botId !== scope.botId)
    throw new BoardError({
      code: "forbidden",
      message: "This board is not available in this space.",
    });
  if (!["completed", "failed", "cancelled"].includes(run.status)) return;
  // Immediate delivery and reconciliation share a durable claim, without holding a DB connection.
  // Bound all host work to two minutes, leaving a minute to stop before crash recovery can take over.
  const deadline = Date.now() + 120_000;
  const token = randomUUID();
  const claimed = await deps.prisma.run.updateMany({
    where: {
      id: run.id,
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId: scope.botId,
      status: run.status,
      boardItemId: run.boardItemId,
      boardWorkspaceId: run.boardWorkspaceId,
      boardCommentedAt: null,
      OR: [{ boardDeliveryExpiresAt: null }, { boardDeliveryExpiresAt: { lte: new Date() } }],
    },
    data: { boardDeliveryToken: token, boardDeliveryExpiresAt: new Date(deadline + 60_000) },
  });
  if (!claimed.count) return;
  try {
    const signal = AbortSignal.any([
      ...(scope.signal ? [scope.signal] : []),
      AbortSignal.timeout(Math.max(0, deadline - Date.now())),
    ]);
    const checkDeadline = () => {
      signal.throwIfAborted();
      // Wall time also catches a paused worker resuming after another worker can reclaim its lease.
      if (Date.now() >= deadline) throw new Error("Board outcome delivery timed out.");
    };
    checkDeadline();
    const completed = run.status === "completed";
    const service = new BoardService({ prisma: deps.prisma, dataDir: deps.dataDir ?? "./data" });
    const provider = await service.provider({ ...scope, signal }, run.boardWorkspaceId);
    checkDeadline();
    const item = await provider.show(run.boardItemId);
    const marker = `[Run ${run.id}]`;
    checkDeadline();
    if (!item.comments.some((comment) => comment.text.startsWith(marker)))
      await provider.comment(
        item.id,
        `${marker} ${completed ? "Completed" : run.status === "cancelled" ? "Cancelled" : "Failed"}\n${outcome.slice(0, 30_000)}`,
      );
    checkDeadline();
    if (completed && run.boardCloseWhenDone && item.closeWhenDone && item.status !== "closed")
      await provider.close([item.id], "Bot reported done");
    checkDeadline();
    await deps.prisma.run.updateMany({
      where: { id: run.id, boardDeliveryToken: token, boardDeliveryExpiresAt: { gt: new Date() } },
      data: {
        boardCommentedAt: new Date(),
        boardDeliveryToken: null,
        boardDeliveryExpiresAt: null,
      },
    });
  } finally {
    // A failed attempt stays pending; a stale worker cannot release a successor's claim.
    await deps.prisma.run.updateMany({
      where: { id: run.id, boardDeliveryToken: token },
      data: { boardDeliveryToken: null, boardDeliveryExpiresAt: null },
    });
  }
}
