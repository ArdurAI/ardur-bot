import type { BoardFiling } from "@ardurbot/contracts/board";

export function filingDestination(
  filing: Pick<BoardFiling, "botId" | "groupId" | "messageId">,
):
  | { pathname: "/group-thread"; params: { groupId: string; messageId?: string } }
  | { pathname: "/thread"; params: { botId: string; messageId?: string } } {
  const message = filing.messageId ? { messageId: filing.messageId } : {};
  if (filing.groupId)
    return { pathname: "/group-thread", params: { groupId: filing.groupId, ...message } };
  return { pathname: "/thread", params: { botId: filing.botId, ...message } };
}
