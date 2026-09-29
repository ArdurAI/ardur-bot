import type { MessageBlock } from "@ardurbot/contracts";
import { isStreamingTextBlock, isToolActivityBlock } from "@ardurbot/core";

export function isCenteredAgentEvent(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "handoff" ||
      block.kind === "bot_message_sent" ||
      block.kind === "bot_message_received" ||
      block.kind === "channel_message",
  );
}

export type MessagePresentationSegment = {
  kind: "content";
  blocks: MessageBlock[];
};

export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
): MessagePresentationSegment[] {
  const content = blocks.filter(
    (block) => block.kind !== "app_connect" && !isToolActivityBlock(block),
  );
  return content.length > 0 ? [{ kind: "content", blocks: content }] : [];
}

export function hasVisibleMessagePresentation(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => !isToolActivityBlock(block));
}

/**
 * The reply cursor shows only while the live draft's tail text is still growing. Once
 * the text stops — the bot moved on to commands, cards, or a handoff — the cursor goes
 * away even though the draft (and its streaming layout) is still live.
 */
export function liveReplyTextStreaming(blocks: readonly MessageBlock[]): boolean {
  const tail = blocks.at(-1);
  return tail !== undefined && isStreamingTextBlock(tail);
}
