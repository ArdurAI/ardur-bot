import type { RawUsageCounts } from "@ardurbot/adapter-kit";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Shared, bounded-field mapping for Chat Completions JSON and SSE chunks. */
export function chatCompletionsUsage(
  payload: unknown,
): Partial<Record<keyof RawUsageCounts, unknown>> | null {
  const value = object(payload);
  const first = Array.isArray(value.choices) ? value.choices[0] : undefined;
  const source = value.usage ?? object(first).usage;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const usage = object(source);
  const input = object(usage.prompt_tokens_details);
  const output = object(usage.completion_tokens_details);
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    cacheRead: input.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens,
    cacheWrite: input.cache_write_tokens,
    reasoning: output.reasoning_tokens,
    total: usage.total_tokens,
  };
}
