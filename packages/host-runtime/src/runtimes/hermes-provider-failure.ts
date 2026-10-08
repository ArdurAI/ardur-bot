import type { FailureCategoryId } from "@ardurbot/contracts/failure-categories";

/** Fixed names only: neither arbitrary property names nor values cross the relay. */
export const HERMES_GRANT_REFUSAL_CATEGORIES = [
  "grant",
  "model",
  "messages",
  "tools",
  "tool-choice",
  "output-tokens",
  "effort",
  "stream-options",
  "sampling",
  "context",
  "request-bytes",
  "run-budget",
  "unknown-field",
  "unknown-field:reasoning",
  "unknown-field:extra_body",
  "unknown-field:user",
  "unknown-field:seed",
  "unknown-field:n",
  "unknown-field:metadata",
  "unknown-field:prompt_cache_key",
  "unknown-field:response_format",
  "unknown-field:service_tier",
  "unknown-field:store",
] as const;

export type HermesGrantRefusalCategory = (typeof HERMES_GRANT_REFUSAL_CATEGORIES)[number];

function grantRefusalMessage(category: HermesGrantRefusalCategory): string {
  return `Provider request is outside this run's grant (${category}).`;
}

export const HERMES_PROVIDER_FAILURE_LAYERS = [
  "upstream",
  "provider-transport",
  "translation",
  "provider-adapter",
] as const;
export const HERMES_PROVIDER_FAILURE_REASONS = [
  "http-auth",
  "http-rate-limit",
  "http-client",
  "http-server",
  "http-other",
  "transport",
  "stream-network",
  "request-translation",
  "provider-stream",
  "response-translation",
] as const;
export type HermesProviderFailureLayer = (typeof HERMES_PROVIDER_FAILURE_LAYERS)[number];
export type HermesProviderFailureReason = (typeof HERMES_PROVIDER_FAILURE_REASONS)[number];

function safeDiagnostic(failure: HermesProviderFailure) {
  const layer = HERMES_PROVIDER_FAILURE_LAYERS.find((value) => value === failure.layer);
  const reason = HERMES_PROVIDER_FAILURE_REASONS.find((value) => value === failure.reason);
  return layer && reason ? { layer, reason } : {};
}

function diagnosticSuffix(failure: HermesProviderFailure): string {
  return failure.layer && failure.reason
    ? ` (layer:${failure.layer}; reason:${failure.reason})`
    : "";
}

/** Only fixed reasons and a validated HTTP status cross the provider/host boundary. */
export type HermesProviderFailure = {
  kind:
    | "profile-unacknowledged"
    | "request-limit"
    | "response-limit"
    | "grant-refused"
    | "sequence-changed"
    | "grant-expired"
    | "disconnected"
    | "provider-http"
    | "provider-failed";
  status?: number;
  layer?: HermesProviderFailureLayer;
  reason?: HermesProviderFailureReason;
  category?: HermesGrantRefusalCategory;
};

function safeFailure(failure: HermesProviderFailure): HermesProviderFailure {
  if (failure.kind === "provider-http") {
    const status = failure.status;
    return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { kind: "provider-http", status, ...safeDiagnostic(failure) }
      : { kind: "provider-failed" };
  }
  if (failure.kind === "grant-refused") {
    const category = HERMES_GRANT_REFUSAL_CATEGORIES.find((value) => value === failure.category);
    return { kind: "grant-refused", ...(category ? { category } : {}) };
  }
  switch (failure.kind) {
    case "profile-unacknowledged":
    case "request-limit":
    case "response-limit":
    case "sequence-changed":
    case "grant-expired":
    case "disconnected":
      return { kind: failure.kind };
    case "provider-failed":
      return { kind: failure.kind, ...safeDiagnostic(failure) };
    default:
      return { kind: "provider-failed" };
  }
}

export class HermesProviderRelayError extends Error {
  readonly failure: HermesProviderFailure;

  constructor(input: HermesProviderFailure) {
    const failure = safeFailure(input);
    super(
      (failure.kind === "provider-http"
        ? `Provider request failed (HTTP ${failure.status}).`
        : failure.kind === "grant-refused" && failure.category
          ? grantRefusalMessage(failure.category)
          : {
              "profile-unacknowledged": "Hermes configuration is not acknowledged.",
              "request-limit": "Provider request exceeded the limit.",
              "response-limit": "Provider response exceeded the limit.",
              "grant-refused": "Provider request is outside this run's grant.",
              "sequence-changed": "Provider response sequence changed.",
              "grant-expired": "Provider grant expired.",
              disconnected: "Provider client disconnected.",
              "provider-failed": "Provider request failed.",
            }[failure.kind]) + diagnosticSuffix(failure),
    );
    this.name = "HermesProviderRelayError";
    this.failure = failure;
  }
}

/** Internal signatures are exact; vendor text, error data and causes are never copied. */
export function hermesProviderFailure(error: unknown): HermesProviderFailure {
  if (error instanceof HermesProviderRelayError) return safeFailure(error.failure);
  const originalMessage = error instanceof Error ? error.message : "";
  const diagnostic =
    /^(Provider request failed(?: \(HTTP [1-5][0-9]{2}\))?\.) \(layer:([a-z-]+); reason:([a-z-]+)\)$/.exec(
      originalMessage,
    );
  const message = diagnostic?.[1] ?? originalMessage;
  const facts = diagnostic
    ? safeDiagnostic({
        kind: "provider-failed",
        layer: diagnostic[2] as HermesProviderFailureLayer,
        reason: diagnostic[3] as HermesProviderFailureReason,
      })
    : {};
  const reasons: Record<string, HermesProviderFailure["kind"]> = {
    "Hermes configuration is not acknowledged.": "profile-unacknowledged",
    "Provider request exceeded the limit.": "request-limit",
    "Provider response exceeded the limit.": "response-limit",
    "Provider response exceeded the broker limit.": "response-limit",
    "Provider event exceeded the broker limit.": "response-limit",
    "Provider response exceeded the turn limit.": "response-limit",
    "Provider request is outside this run's grant.": "grant-refused",
    "Provider request could not be admitted.": "grant-refused",
    "Provider response sequence changed.": "sequence-changed",
    "Provider grant expired.": "grant-expired",
    "Provider client disconnected.": "disconnected",
  };
  const category = HERMES_GRANT_REFUSAL_CATEGORIES.find(
    (value) => message === grantRefusalMessage(value),
  );
  if (category) return { kind: "grant-refused", category };
  const status = /^Provider request failed \(HTTP ([1-5][0-9]{2})\)\.$/.exec(message)?.[1];
  if (status) return { kind: "provider-http", status: Number(status), ...facts };
  return {
    ...facts,
    kind: Object.hasOwn(reasons, message)
      ? (reasons[message] ?? "provider-failed")
      : "provider-failed",
  };
}

export function hermesProviderFailureCategory(failure: HermesProviderFailure): FailureCategoryId {
  switch (failure.kind) {
    case "profile-unacknowledged":
      return "runtime-profile-unacknowledged";
    case "request-limit":
      return "provider-request-too-large";
    case "response-limit":
      return "provider-response-too-large";
    case "grant-refused":
    case "grant-expired":
      return "provider-grant-refused";
    case "provider-http":
      if (failure.status === 401 || failure.status === 403) return "provider-auth-failed";
      if (failure.status === 429) return "usage-limit";
      return "provider-request-failed";
    default:
      return "provider-request-failed";
  }
}
