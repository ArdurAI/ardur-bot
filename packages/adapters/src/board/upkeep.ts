import { BOT_FILED_LABEL, BoardError } from "@ardurbot/contracts/board";
import { redactSecrets } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { currentRemoteDecision } from "../remote-execution.js";
import { filingBotName } from "./filing.js";
import type { BoardScope, BoardService } from "./service.js";

export { filingBotName };

export const RUN_FILING_CAP = 5;
export const SPACE_FILING_CAP = 30;
export const RUN_FILING_LIMIT =
  "This run already filed 5 board items. Comment on an existing item instead of creating another.";
export const SPACE_FILING_LIMIT =
  "This space already filed 30 board items this hour. Try again later.";
export const MEMORY_UPKEEP_SENTENCE =
  "Use remember for a durable learning. Never store a secret or one-off chatter.";
const BOARD_WORK =
  "Keep the board current. Find or claim the item this run serves, or link your work to one. Before you file new work, check for an open item with the same title. File work you will not finish now as a new item with acceptance criteria, and link it to the current item. Comment the outcome on each item you touch. Close an item you completed, and give a reason.";
/** Included only when board writes are available. Measured by measureInstructionTokens. */
export const BOARD_UPKEEP_SECTION = `${BOARD_WORK} ${MEMORY_UPKEEP_SENTENCE}`;
export const BOARD_READ_TOOLS = new Set(["board_ready", "board_show"]);
export const BOARD_WRITE_TOOLS = new Set([
  "board_create",
  "board_update",
  "board_claim",
  "board_close",
  "board_comment",
  "board_link",
]);
export type BoardToolAccess = "write" | "read" | "none";
export type BoardUnavailableReason = "no-board" | "unreachable" | "read-only";

/** Unicode words and separate punctuation. The board section stays at or under 150. */
export function measureInstructionTokens(text: string): number {
  return text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length ?? 0;
}

export function boardUnavailableSentence(reason: BoardUnavailableReason): string {
  if (reason === "unreachable") return "This bot cannot reach the board's computer.";
  if (reason === "read-only") return "This board is read-only for this run.";
  return "This space has no board this bot can use.";
}

export function alternateBoardSentence(workspaceIds: readonly string[]): string {
  return `Pass workspaceId ${workspaceIds.join(" or ")}.`;
}

export function botUpkeepPrompt(input: {
  enabled: boolean;
  board: BoardToolAccess;
  reason: BoardUnavailableReason | null;
  memory: boolean;
  workspaceIds?: readonly string[];
}): string {
  if (!input.enabled) return "";
  const hint = input.workspaceIds?.length ? ` ${alternateBoardSentence(input.workspaceIds)}` : "";
  if (input.board === "write") return `${input.memory ? BOARD_UPKEEP_SECTION : BOARD_WORK}${hint}`;
  const reason = input.reason ?? (input.board === "read" ? "read-only" : "no-board");
  return `${[boardUnavailableSentence(reason), input.memory ? MEMORY_UPKEEP_SENTENCE : ""]
    .filter(Boolean)
    .join(" ")}${hint}`;
}

export function applyBoardToolAccess<T extends { name: string }>(
  tools: T[],
  input: { enabled: boolean; board: BoardToolAccess },
): T[] {
  if (!input.enabled || input.board === "write") return tools;
  if (input.board === "read") return tools.filter((tool) => !BOARD_WRITE_TOOLS.has(tool.name));
  return tools.filter(
    (tool) => !BOARD_READ_TOOLS.has(tool.name) && !BOARD_WRITE_TOOLS.has(tool.name),
  );
}

export function normalizeBoardTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function duplicateBoardItemMessage(id: string): string {
  return `An open item already has this title: ${id}.`;
}

export function redactBoardText(value: string, secrets: string[]): string {
  return secrets.length ? redactSecrets(value, secrets) : value;
}

export function withBotFiledLabel(labels: string[] | undefined): string[] {
  const next = [...new Set([...(labels ?? []), BOT_FILED_LABEL])];
  if (next.length <= 50) return next;
  return [...next.filter((label) => label !== BOT_FILED_LABEL).slice(0, 49), BOT_FILED_LABEL];
}

const UNREACHABLE = "This bot cannot reach this board's computer.";

export function isBoardUnreachable(error: unknown): boolean {
  return error instanceof BoardError && error.message === UNREACHABLE;
}

export async function resolveBoardAccess(
  service: BoardService,
  prisma: PrismaClient,
  scope: BoardScope,
): Promise<{
  board: BoardToolAccess;
  reason: BoardUnavailableReason | null;
  workspaceIds: string[];
}> {
  const none = (reason: BoardUnavailableReason) => ({
    board: "none" as const,
    reason,
    workspaceIds: [] as string[],
  });
  let choice: Awaited<ReturnType<BoardService["botBoardChoices"]>>;
  try {
    choice = await service.botBoardChoices(scope);
  } catch (error) {
    if (!(error instanceof BoardError)) throw error;
    if (isBoardUnreachable(error)) return none("unreachable");
    return none("no-board");
  }
  if (choice.admitted.length === 0) return none("no-board");
  const workspaceIds = choice.implicitAdmitted ? [] : choice.admitted.map((row) => row.id);
  if (!scope.runId) return { board: "write", reason: null, workspaceIds };
  const write = await currentRemoteDecision(prisma, scope.runId, "board_create");
  if (write.allowed) return { board: "write", reason: null, workspaceIds };
  if (write.kind === "presence") return { board: "write", reason: null, workspaceIds };
  const read = await currentRemoteDecision(prisma, scope.runId, "board_ready");
  return {
    board: read.allowed ? "read" : "none",
    reason: "read-only",
    workspaceIds: read.allowed ? workspaceIds : [],
  };
}
