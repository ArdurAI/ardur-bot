import { ChatMarkdown } from "@ardurbot/chat-ui/web";
import type { MessageBlock } from "@ardurbot/contracts";

/**
 * Reply narration inside the bubble: text blocks and streaming progress beats,
 * in order. Progress blocks render with the streaming caret while they live.
 */
export function NarrationBlocks({
  blocks,
  quoteMessageId,
}: {
  blocks: MessageBlock[];
  quoteMessageId?: string;
}) {
  return blocks.map((block, i) => {
    if (block.kind === "text" || block.kind === "progress") {
      return (
        <div key={i} data-quote-message-id={block.kind === "text" ? quoteMessageId : undefined}>
          <ChatMarkdown streaming={block.kind === "progress"}>{block.text}</ChatMarkdown>
        </div>
      );
    }
    return null;
  });
}
