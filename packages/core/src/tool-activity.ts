import type { MessageBlock } from "@ardurbot/contracts";

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

/** True only while a live reply's text is still growing — the sole state with a cursor. */
export function isStreamingTextBlock(block: MessageBlock): boolean {
  return block.kind === "progress" && block.streaming === true && block.activity !== true;
}
