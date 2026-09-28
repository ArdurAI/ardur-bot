import type { MessageBlock } from "@ardurbot/contracts";
import {
  isInterimNarrationAt,
  isReasoningSummaryBlock,
  isToolActivityBlock,
  workRecordEntries,
} from "@ardurbot/core";

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
  // Tool activity, reasoning summaries, and interim narration live in the
  // compact work record, not the bubble. Plain narration (including old
  // stored messages with no reasoning flag) stays in the bubble.
  const content = blocks.filter(
    (block, index) =>
      block.kind !== "app_connect" &&
      !isToolActivityBlock(block) &&
      !isReasoningSummaryBlock(block) &&
      !isInterimNarrationAt(blocks, index),
  );
  return content.length > 0 ? [{ kind: "content", blocks: content }] : [];
}

export function hasVisibleMessagePresentation(blocks: readonly MessageBlock[]): boolean {
  // A tool-only or reasoning-only message still shows its compact work record.
  return (
    blocks.some((block) => !isToolActivityBlock(block)) || workRecordEntries(blocks).length > 0
  );
}
