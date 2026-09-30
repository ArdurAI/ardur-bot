import { providerRetryWaitMs } from "@ardurbot/contracts";
import { ProviderError } from "./provider-error.js";

export interface ProviderRetryDecisionInput {
  /** The failure that ended the run's attempt. */
  error: unknown;
  /** The run has shown something already: visible text, a tool call, a question or an approval. */
  shown: boolean;
  /** The run was asked to stop. */
  cancelRequested: boolean;
  /** Retries this run has already taken for provider refusals. */
  attemptsSoFar: number;
  /** The moment the run must finish by, when it has one. */
  deadlineAt: Date | null;
  now: Date;
  random: () => number;
}

export interface ProviderRetryDecision {
  waitMs: number;
  /** The retry number this wait precedes; 1 is the first retry. */
  attempt: number;
}

/**
 * Whether a failed run that has shown nothing yet waits and tries again instead of
 * failing. Only a provider refusal whose kind retries qualifies: the run must still be
 * silent (a retry cannot double a reply already partly shown), not asked to stop, and
 * able to wake before its deadline.
 */
export function shouldRetryProviderFailure(
  input: ProviderRetryDecisionInput,
): ProviderRetryDecision | null {
  if (!(input.error instanceof ProviderError)) return null;
  if (input.shown || input.cancelRequested) return null;
  const attempt = input.attemptsSoFar + 1;
  const waitMs = providerRetryWaitMs({
    kind: input.error.providerErrorKind,
    attempt,
    providerWaitMs: input.error.retryAfterMs,
    random: input.random,
  });
  if (waitMs === null) return null;
  if (input.deadlineAt && input.now.getTime() + waitMs > input.deadlineAt.getTime()) return null;
  return { waitMs, attempt };
}
