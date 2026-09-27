import type { MessageBlock } from "@ardurbot/contracts";

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

/** Only persisted delivery projections can advance a receipt. */
export function botMessageReceiptKind(block: PeerBlock) {
  if (block.deliveryState === "replied") return "replied";
  if (block.deliveryState === "expired") return "expired";
  if (block.deliveryState === "failed") return "failed";
  if (block.queuedForBusy) return "waiting";
  if (block.deliveryState === "read") return "read";
  if (block.deliveryState === "delivered") return "delivered";
  return "sent";
}
