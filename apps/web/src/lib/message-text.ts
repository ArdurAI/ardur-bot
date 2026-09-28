import type { MessageBlock, ThreadMessage } from "@ardurbot/contracts";
import { isReasoningSummaryBlock, isToolActivityBlock } from "@ardurbot/core";
import { messageProviderLabel } from "./messaging";

/**
 * Blocks shown inside the reply bubble. Tool activity and reasoning summaries
 * are excluded — both live in the compact work record, each exactly once.
 */
export function narrationBubbleBlocks(blocks: readonly MessageBlock[]): MessageBlock[] {
  return blocks.filter((block) => !isToolActivityBlock(block) && !isReasoningSummaryBlock(block));
}

/** Plain message text for clipboard copy — text/ask/progress only, no chrome. */
export function copyableMessageText(message: ThreadMessage): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messageProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
