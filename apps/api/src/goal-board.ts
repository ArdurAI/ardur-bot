import type { BoardScope, BoardService } from "@ardurbot/adapters";
import { BoardService as BoardServiceClass } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { BoardError } from "@ardurbot/contracts/board";
import type { Pool, PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { boardOwnerRun } from "./board.js";
import type { HostBridge } from "./host-bridge.js";

export function goalBoardService(deps: {
  prisma: PrismaClient;
  dataDir: string;
  lockPool?: Pick<Pool, "connect">;
  hostBridge?: HostBridge;
}) {
  return new BoardServiceClass({
    prisma: deps.prisma,
    dataDir: deps.dataDir,
    lockPool: deps.lockPool,
    ownerRun: deps.hostBridge ? boardOwnerRun(deps.hostBridge) : undefined,
  });
}

/** Owner, space, workspace and item must all match before a goal stores the link. */
export async function authorizeGoalBoardLink(
  actor: Actor,
  link: { workspaceId: string; itemId: string } | null,
  board: Pick<BoardService, "actor" | "workspace" | "provider">,
) {
  if (!link) return null;
  if (!actor.isDeploymentOwner) throw new IsolationError();
  const scope: BoardScope = { userId: actor.userId, spaceId: actor.spaceId };
  await board.actor(scope);
  const workspace = await board.workspace(scope, link.workspaceId);
  if (workspace.spaceId !== actor.spaceId || workspace.ownerUserId !== actor.userId)
    throw new IsolationError();
  const item = await (await board.provider(scope, workspace.id)).show(link.itemId);
  if (item.id !== link.itemId)
    throw new BoardError({ code: "item_not_found", message: "This work item was not found." });
  return { workspaceId: workspace.id, itemId: item.id };
}
