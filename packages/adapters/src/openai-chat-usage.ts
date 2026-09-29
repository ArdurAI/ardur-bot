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
  const hit = usage.prompt_cache_hit_tokens;
  const miss = usage.prompt_cache_miss_tokens;
  let prompt = usage.prompt_tokens;
  // DeepSeek-style OpenAI-compatible endpoints (including Z.ai's GLM routes)
  // report prompt_tokens WITHOUT the cache-hit portion and disclose the hit
  // count beside it, while standard endpoints include cached tokens in
  // prompt_tokens. Only the exact hit/miss pair with an equal miss total
  // evidences the exclusive shape; adding hit tokens then keeps the cache
  // subsets partitioning logical input instead of failing validation.
  if (typeof hit === "number" && hit > 0 && typeof miss === "number" && prompt === miss)
    prompt = miss + hit;
  return {
    input: prompt,
    output: usage.completion_tokens,
    cacheRead: input.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens,
    cacheWrite: input.cache_write_tokens,
    reasoning: output.reasoning_tokens,
    total: usage.total_tokens,
  };
}
