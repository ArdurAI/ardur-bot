import type { ThreadMessage } from "@ardurbot/contracts";

type PeerMessage = Pick<ThreadMessage, "id" | "blocks"> &
  Partial<Pick<ThreadMessage, "botId" | "replyToMessageId">>;

export type PeerTranscriptEntry = {
  messageId: string;
  authorBotId: string;
  direction: "sent" | "received";
  text: string;
  truncated: boolean;
};

/** Select one pair from a room, using the outbound echo to identify its replies. */
export function selectPeerTranscript(
  messages: readonly PeerMessage[],
  botId: string | undefined,
  peerBotId: string,
  groupScoped: boolean,
): PeerTranscriptEntry[] {
  const sent = new Set<string>();
  const deliveries = new Set<string>();
  for (const message of messages) {
    if (groupScoped && message.botId !== botId) continue;
    for (const block of message.blocks) {
      if (block.kind !== "bot_message_sent" || block.toBotId !== peerBotId) continue;
      sent.add(message.id);
      if (block.deliveryId) deliveries.add(block.deliveryId);
    }
  }

  const selected: PeerTranscriptEntry[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "bot_message_sent") {
        if (block.toBotId !== peerBotId || (groupScoped && message.botId !== botId)) continue;
        selected.push({
          messageId: message.id,
          authorBotId: message.botId ?? botId ?? "",
          direction: "sent",
          text: block.text,
          truncated: false,
        });
      } else if (block.kind === "bot_message_received" && block.fromBotId === peerBotId) {
        if (
          groupScoped &&
          !(
            (message.replyToMessageId && sent.has(message.replyToMessageId)) ||
            (block.returnToMessageId && sent.has(block.returnToMessageId)) ||
            (block.deliveryId && deliveries.has(block.deliveryId))
          )
        )
          continue;
        selected.push({
          messageId: message.id,
          authorBotId: block.fromBotId,
          direction: "received",
          text: block.text,
          truncated: Boolean(block.truncated),
        });
      }
    }
  }
  return selected;
}
