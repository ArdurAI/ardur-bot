import type { MessageBlock, ThreadMessage } from "@ardurbot/contracts";
import { isStreamingTextBlock } from "@ardurbot/core";
import { messageProviderLabel } from "./messaging";

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

/**
 * How a reply's text or progress block renders: live progress keeps the streaming layout
 * (partial fences stay sealed), and the cursor shows only while its text is still growing.
 */
export function replyMarkdownProps(block: MessageBlock): { streaming: boolean; cursor: boolean } {
  return { streaming: block.kind === "progress", cursor: isStreamingTextBlock(block) };
}
