import type { ProviderErrorKind } from "@ardurbot/contracts";

/**
 * Carries classification across sanitization without retaining the raw provider response.
 * `retryAfterMs` is the provider's own asked-for wait when it exposed one (a Retry-After
 * header or retryAfter field on the SDK's error), so the retry policy can honour it.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerErrorKind: ProviderErrorKind,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function classifyProviderError(error: unknown): ProviderErrorKind {
  return classify(error, 0);
}

/**
 * The wait the provider itself asked for, in milliseconds, when its error exposes one:
 * a `retry-after-ms` or `retry-after` header (Headers instance or plain map) or a
 * `retryAfter`/`retryAfterMs` field. A `retry-after` value is seconds, or an HTTP date
 * measured from now. Undefined when the provider said nothing.
 */
export function providerRetryAfterMs(error: unknown, now = Date.now()): number | undefined {
  return retryAfter(error, 0, now);
}

function retryAfter(error: unknown, depth: number, now: number): number | undefined {
  if (depth > 8) return undefined;
  if (error instanceof ProviderError) return error.retryAfterMs;
  if (!error || typeof error !== "object") return undefined;
  const headers = "headers" in error ? Reflect.get(error, "headers") : undefined;
  if (headers) {
    const read = (name: string): string | null => {
      if (typeof headers.get === "function") return headers.get(name);
      const lower = headers as Record<string, unknown>;
      for (const key of Object.keys(lower)) {
        if (key.toLowerCase() === name) {
          const value = lower[key];
          return typeof value === "string" || typeof value === "number" ? String(value) : null;
        }
      }
      return null;
    };
    const milliseconds = read("retry-after-ms");
    if (milliseconds != null) {
      const value = Number.parseFloat(milliseconds);
      if (!Number.isNaN(value)) return value;
    }
    const seconds = read("retry-after");
    if (seconds != null) {
      if (/^\d+(?:\.\d+)?$/.test(seconds.trim())) return Number.parseFloat(seconds) * 1_000;
      const date = Date.parse(seconds);
      if (!Number.isNaN(date)) return date - now;
    }
  }
  if ("retryAfterMs" in error) {
    const value = Number(Reflect.get(error, "retryAfterMs"));
    if (Number.isFinite(value)) return value;
  }
  if ("retryAfter" in error) {
    const raw = Reflect.get(error, "retryAfter");
    if (typeof raw === "number" && Number.isFinite(raw)) return raw * 1_000;
    if (typeof raw === "string") {
      const value = Number.parseFloat(raw);
      if (!Number.isNaN(value)) return value * 1_000;
    }
  }
  for (const field of ["error", "detail", "message"] as const) {
    if (field in error) {
      const found = retryAfter(Reflect.get(error, field), depth + 1, now);
      if (found != null) return found;
    }
  }
  return undefined;
}

function classify(error: unknown, depth: number): ProviderErrorKind {
  if (depth > 8) return "other";
  if (error instanceof ProviderError) return error.providerErrorKind;
  if (typeof error === "string") {
    try {
      return classify(JSON.parse(error), depth + 1);
    } catch {
      if (
        /\bmodel\b(?:\s+["'`][^"'`\n]+["'`]|\s+[\w./:-]+)?\s+(?:is\s+)?(?:not supported|not available|does not exist|not found|unknown)\b|\bunknown model\b/i.test(
          error,
        )
      ) {
        return "model-unavailable";
      }
      if (
        /\b(rate limit|too many requests|quota exceeded|usage limit)\b|\bout of (?:extra )?usage\b/i.test(
          error,
        )
      )
        return "rate-limit";
      if (
        /\b(unauthorized|authentication|invalid api key|expired token|token expired)\b/i.test(error)
      )
        return "auth";
      return "other";
    }
  }
  if (!error || typeof error !== "object") return "other";
  const status =
    "status" in error ? error.status : "statusCode" in error ? error.statusCode : undefined;
  const code = "code" in error ? error.code : undefined;
  if (code === "model_not_found" || code === "model_not_available" || code === "unsupported_model")
    return "model-unavailable";
  if (status === 429 || code === "rate_limit_exceeded") return "rate-limit";
  if (status === 401 || code === "invalid_api_key" || code === "authentication_error")
    return "auth";
  for (const field of ["error", "detail", "message"] as const) {
    if (field in error) {
      const kind = classify(Reflect.get(error, field), depth + 1);
      if (kind !== "other") return kind;
    }
  }
  return "other";
}
