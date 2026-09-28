import type { MessageBlock } from "@ardurbot/contracts";

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

/**
 * Reasoning summaries stream as progress beats without tool activity. They
 * belong in the compact work record, never in the reply bubble.
 */
export function isReasoningSummaryBlock(block: MessageBlock): boolean {
  return block.kind === "progress" && block.activity !== true;
}
