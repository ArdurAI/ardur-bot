import type { RuntimePin, RuntimeProblem } from "@ardurbot/contracts/runtime-pins";
import { runtimeNames, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";

/**
 * Limit and sign-in signals in a native runtime's own error text. "out of extra usage" is
 * Anthropic's documented 400 for an exhausted plan (packages/adapters/src/mcp-connector.ts
 * works around exactly that text); the remaining patterns are the provider-error
 * classifier's (packages/adapters/src/provider-error.ts) applied to native output, and the
 * sign-in patterns Antigravity already matches (antigravity-stream.ts).
 */
const USAGE_LIMIT_SIGNAL = /usage limit|out of (?:extra )?usage|rate limit|too many requests/i;
const SIGN_IN_SIGNAL =
  /not logged in|not signed in|sign in required|invalid api key|unauthorized|authentication/i;

/** The category of a native runtime failure, or undefined when the text says nothing known. */
export function nativeFailureReasonId(detail: string): "usage-limit" | "signed-out" | undefined {
  if (USAGE_LIMIT_SIGNAL.test(detail)) return "usage-limit";
  if (SIGN_IN_SIGNAL.test(detail)) return "signed-out";
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

/** A category sentence for a native failure; never echoes the runtime's raw text. */
export function nativeFailureProblem(
  pin: RuntimePin,
  reasonId: "usage-limit" | "signed-out" | "max-turns",
): RuntimeProblem {
  const name = runtimeNames[pin.runtimeKind] ?? "This runtime";
  if (reasonId === "usage-limit")
    return runtimePinProblem(
      pin,
      "runtime-unavailable",
      `${name}'s usage limit is reached. Try again after it resets.`,
      reasonId,
    );
  if (reasonId === "signed-out")
    return runtimePinProblem(
      pin,
      "runtime-unavailable",
      `Sign in to ${name} on this computer, then try again.`,
      reasonId,
    );
  return runtimePinProblem(
    pin,
    "runtime-unavailable",
    `${name} reached this run's turn limit. Narrow the task and try again.`,
    reasonId,
  );
}
