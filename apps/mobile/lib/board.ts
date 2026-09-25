import type {
  BoardProblem,
  BoardSnapshot,
  BoardWorkspace,
  WorkItem,
} from "@ardurbot/contracts/board";
import { BoardSnapshotSchema, WorkItemSchema } from "@ardurbot/contracts/board";
import { rpc } from "./api";
export async function loadBoardWorkspaces() {
  return rpc<{ workspaces: BoardWorkspace[]; problem: BoardProblem | null }>(
    "board/workspaces",
    {},
  );
}
export async function loadBoardReady(workspaceId: string) {
  const board = BoardSnapshotSchema.parse(
    await rpc<BoardSnapshot>("board/snapshot", { workspaceId }),
  );
  return board.items.filter((item) => board.readyIds.includes(item.id));
}
export async function loadBoardItem(workspaceId: string, id: string): Promise<WorkItem> {
  return WorkItemSchema.parse(await rpc("board/show", { workspaceId, id }));
}

export function boardProblemText(
  problem: BoardProblem,
  translate: (text: string, values?: Record<string, string | number>) => string,
) {
  if (problem.code === "unsupported_version") {
    const version = /^Beads version (.+) is not supported yet$/.exec(problem.message)?.[1] ?? "?";
    return translate("Beads version {version} is not supported yet", { version });
  }
  const messages: Partial<Record<BoardProblem["code"], string>> = {
    not_installed: "Beads is not installed on this computer",
    no_board: "This folder has no board",
    busy: "Another write is in progress",
    timeout: "The board command timed out.",
    dolt_missing: "Dolt is not installed on this computer.",
  };
  return translate(messages[problem.code] ?? "Could not load Board; retry.");
}
