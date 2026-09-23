import type { ProviderErrorKind } from "@ardurbot/contracts";

/** Carries classification across sanitization without retaining the raw provider response. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerErrorKind: ProviderErrorKind,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function classifyProviderError(error: unknown): ProviderErrorKind {
  return classify(error, 0);
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
      if (/\b(rate limit|too many requests|quota exceeded)\b/i.test(error)) return "rate-limit";
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
