import type { MessageBlock, ThreadMessage } from "@ardurbot/contracts";
import {
  isInterimNarrationAt,
  isReasoningSummaryBlock,
  isToolActivityBlock,
  workRecordEntries,
} from "@ardurbot/core";
import { messageProviderLabel } from "./messaging";

/**
 * Blocks shown inside the reply bubble. Tool activity, supplied reasoning
 * summaries, and interim narration (notes interrupted by later tool activity)
 * live in the compact work record instead. Plain narration — including old
 * stored messages with no reasoning flag — streams and stays here.
 */
export function narrationBubbleBlocks(blocks: readonly MessageBlock[]): MessageBlock[] {
  return blocks.filter(
    (block, index) =>
      !isToolActivityBlock(block) &&
      !isReasoningSummaryBlock(block) &&
      !isInterimNarrationAt(blocks, index),
  );
}

/**
 * True while an in-flight message already shows the run's activity — reply
 * text streaming in the bubble or a visible compact work record — so the
 * transcript does not need the fallback working glyph as a second indicator.
 */
export function liveMessageHasVisibleActivity(message: ThreadMessage): boolean {
  if (!message.id.startsWith("progress:")) return false;
  return (
    message.blocks.some(
      (block) => block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
    ) || workRecordEntries(message.blocks).length > 0
  );
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
