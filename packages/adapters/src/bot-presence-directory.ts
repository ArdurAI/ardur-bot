import { renderBotPresenceDirectory } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { loadBotPresence } from "@ardurbot/db";

const DESK_DIRECTORY_LIMIT = 40;

/** Select a whole room before bounding the broader desk directory. */
export async function loadRunBotDirectory(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
  selfId: string,
  groupId: string | undefined,
  canSend: boolean,
): Promise<string | undefined> {
  const result = await loadBotPresence(prisma, scope, {
    callerBotId: selfId,
    canSend,
    ...(groupId ? { groupId, visibleGroupId: groupId } : { limit: DESK_DIRECTORY_LIMIT }),
  });
  return renderBotPresenceDirectory(result.bots, selfId, groupId);
}
