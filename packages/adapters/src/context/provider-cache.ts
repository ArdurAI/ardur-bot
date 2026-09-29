type Block = { type?: string; text?: string; cache_control?: unknown };

// Anthropic accepts at most four cache breakpoints per request.
const MAX_BREAKPOINTS = 4;

function markers(items: unknown): unknown[] {
  return Array.isArray(items)
    ? items.flatMap((item: Block | null) => (item?.cache_control ? [item.cache_control] : []))
    : [];
}

/**
 * The SDK marks the tools, the system prompt and the latest message. The latest message changes
 * every turn, so the next turn can read back only what ends at a marker it still shares: mark the
 * last history message that repeats, with the SDK's own marker so retention stays consistent.
 */
function markStableHistory(request: Record<string, unknown>, end: { index: number; text: string }) {
  const messages = request.messages;
  if (!Array.isArray(messages)) return request;
  const message = messages[end.index] as { role?: string; content?: unknown } | undefined;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1 && content[0]?.type === "text"
        ? content[0].text
        : undefined;
  const used = [
    ...markers(request.tools),
    ...markers(request.system),
    ...messages.flatMap((item: { content?: unknown }) => markers(item?.content)),
  ];
  if (
    message?.role !== "user" ||
    text !== end.text ||
    !used.length ||
    used.length >= MAX_BREAKPOINTS
  )
    return request;
  return {
    ...request,
    messages: messages.map((item, index) =>
      index === end.index
        ? { ...item, content: [{ type: "text", text, cache_control: used.at(-1) }] }
        : item,
    ),
  };
}

/**
 * The SDK's payload hook lets the protocol adapter mark exactly the stable system block and,
 * when given, the end of the history that repeats next turn.
 */
export function markStablePrefix(
  payload: unknown,
  stablePrefix: string | undefined,
  stableHistoryEnd?: { index: number; text: string },
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const request = payload as Record<string, unknown>;
  const system = request.system;
  const blocks: Block[] =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : Array.isArray(system)
        ? system
        : [];
  const marked =
    stablePrefix !== undefined &&
    blocks.length > 0 &&
    blocks.map((block) => block.text ?? "").join("\n\n") === stablePrefix
      ? {
          ...request,
          system: blocks.map((block, index) =>
            index === blocks.length - 1
              ? { ...block, cache_control: block.cache_control ?? { type: "ephemeral" } }
              : block,
          ),
        }
      : request;
  return stableHistoryEnd ? markStableHistory(marked, stableHistoryEnd) : marked;
}
