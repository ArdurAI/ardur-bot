import type { FailureCategoryId } from "@ardurbot/contracts/failure-categories";

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
};

function safeFailure(failure: HermesProviderFailure): HermesProviderFailure {
  if (failure.kind === "provider-http") {
    const status = failure.status;
    return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { kind: "provider-http", status }
      : { kind: "provider-failed" };
  }
  switch (failure.kind) {
    case "profile-unacknowledged":
    case "request-limit":
    case "response-limit":
    case "grant-refused":
    case "sequence-changed":
    case "grant-expired":
    case "disconnected":
    case "provider-failed":
      return { kind: failure.kind };
    default:
      return { kind: "provider-failed" };
  }
}

export class HermesProviderRelayError extends Error {
  readonly failure: HermesProviderFailure;

  constructor(input: HermesProviderFailure) {
    const failure = safeFailure(input);
    super(
      failure.kind === "provider-http"
        ? `Provider request failed (HTTP ${failure.status}).`
        : {
            "profile-unacknowledged": "Hermes configuration is not acknowledged.",
            "request-limit": "Provider request exceeded the limit.",
            "response-limit": "Provider response exceeded the limit.",
            "grant-refused": "Provider request is outside this run's grant.",
            "sequence-changed": "Provider response sequence changed.",
            "grant-expired": "Provider grant expired.",
            disconnected: "Provider client disconnected.",
            "provider-failed": "Provider request failed.",
          }[failure.kind],
    );
    this.name = "HermesProviderRelayError";
    this.failure = failure;
  }
}

/** Internal signatures are exact; vendor text, error data and causes are never copied. */
export function hermesProviderFailure(error: unknown): HermesProviderFailure {
  if (error instanceof HermesProviderRelayError) return safeFailure(error.failure);
  const message = error instanceof Error ? error.message : "";
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
  const status = /^Provider request failed \(HTTP ([1-5][0-9]{2})\)\.$/.exec(message)?.[1];
  if (status) return { kind: "provider-http", status: Number(status) };
  return {
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
