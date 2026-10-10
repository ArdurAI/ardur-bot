import type { FailureCategoryId } from "@ardurbot/contracts/failure-categories";
import { failureCategory, failureCategoryMessage } from "@ardurbot/contracts/failure-categories";
import type { RuntimePin, RuntimeProblem } from "@ardurbot/contracts/runtime-pins";
import { runtimeNames, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";

/**
 * Limit, sign-in and model signals in a native runtime's own error text. "out of extra
 * usage" is Anthropic's documented 400 for an exhausted plan
 * (packages/adapters/src/mcp-connector.ts works around exactly that text); the remaining
 * patterns are the provider-error classifier's (packages/adapters/src/provider-error.ts)
 * applied to native output, and the sign-in patterns Antigravity already matches
 * (antigravity-stream.ts).
 */
const USAGE_LIMIT_SIGNAL =
  /usage[_ -]?limit|out of (?:extra )?usage|rate[_ -]?limit|too many requests|quota exceeded|insufficient_quota/i;
const SIGN_IN_SIGNAL =
  /not logged in|not signed in|sign in required|invalid[_ ]api[_ ]key|unauthorized|authentication|expired token|token expired/i;
const MODEL_UNAVAILABLE_SIGNAL =
  /\bmodel\b(?:\s+["'`][^"'`\n]+["'`]|\s+[\w./:-]+)?\s+(?:is\s+)?(?:not supported|not available|does not exist|not found|unknown)\b|\bunknown model\b|model_not_found|model_not_available|unsupported_model/i;

/** The category of a native runtime failure, or undefined when the text says nothing known. */
export function nativeFailureCategory(detail: string): FailureCategoryId | undefined {
  if (USAGE_LIMIT_SIGNAL.test(detail)) return "usage-limit";
  if (SIGN_IN_SIGNAL.test(detail)) return "signed-out";
  if (MODEL_UNAVAILABLE_SIGNAL.test(detail)) return "model-unavailable";
  return undefined;
}

/** Join the free-text fields a terminal event may carry, for signal matching only. */
export function nativeFailureDetail(...values: unknown[]): string {
  return values
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      // Error objects carry their text under message; anything else has nothing to match.
      if (value && typeof value === "object" && "message" in value)
        return [(value as { message: unknown }).message];
      return [value];
    })
    .filter((entry): entry is string => typeof entry === "string")
    .join("\n");
}

/**
 * A category sentence for a native failure, from the failure-category table; never echoes
 * the runtime's raw text.
 */
export function nativeFailureProblem(pin: RuntimePin, reasonId: FailureCategoryId): RuntimeProblem {
  const name = runtimeNames[pin.runtimeKind] ?? "This runtime";
  const problem = runtimePinProblem(
    pin,
    "runtime-unavailable",
    failureCategoryMessage(reasonId, { runtime: name }),
    reasonId,
  );
  const action = failureCategory(reasonId).action;
  if (action.kind === "retry") problem.actions = ["retry"];
  if (action.kind === "connect") problem.actions = ["connect"];
  return problem;
}
