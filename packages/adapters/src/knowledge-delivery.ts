import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";

/** Bound before the runtime serializes a tool result, so exposure hashes describe delivered text. */
export function boundedKnowledgeText(
  content: string,
  envelope: (text: string) => unknown,
  limit = TOOL_RESULT_TEXT_LIMIT,
): string {
  if (JSON.stringify(envelope(content)).length <= limit) return content;
  let low = 0;
  let high = Math.min(content.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(envelope(content.slice(0, middle))).length <= limit) low = middle;
    else high = middle - 1;
  }
  // Do not expose a lone high surrogate at the boundary.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(content[low - 1]!)) low--;
  return content.slice(0, low);
}
