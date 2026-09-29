import type { MessageBlock } from "@ardurbot/contracts";

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

/**
 * Supplied reasoning summaries carry an explicit marker. A progress block
 * without it is assistant-authored narration (including old stored messages).
 */
export function isReasoningSummaryBlock(block: MessageBlock): boolean {
  return block.kind === "progress" && block.reasoning === true;
}

/**
 * Narration that later tool activity interrupts is an interim note: it folds
 * into the compact work record instead of streaming in the reply bubble. This
 * covers both streaming progress beats and text flushed before a tool call.
 * The trailing narration after the last tool activity stays in the bubble.
 */
export function isInterimNarrationAt(blocks: readonly MessageBlock[], index: number): boolean {
  const block = blocks[index];
  if (!block) return false;
  const narration =
    block.kind === "text" ||
    (block.kind === "progress" && block.activity !== true && block.reasoning !== true);
  if (!narration) return false;
  return blocks.slice(index + 1).some((later) => isToolActivityBlock(later));
}

/** True only while a live reply's text is still growing — the sole state with a cursor. */
export function isStreamingTextBlock(block: MessageBlock): boolean {
  return (
    block.kind === "progress" &&
    block.streaming === true &&
    block.activity !== true &&
    block.reasoning !== true
  );
}

/**
 * True once a run's live draft shows reply text the owner has seen stream:
 * narration or sealed text, never tool activity or a reasoning summary. The
 * server holds the reply's thread place from that first streamed text, so the
 * client keeps the draft in that place from there on.
 */
export function showsReplyText(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "text" ||
      (block.kind === "progress" && block.activity !== true && block.reasoning !== true),
  );
}
