import { fallbackORPCErrorMessage, ORPCError } from "@orpc/client";

/**
 * The server's own sentence when a request failed for a reason worth saying, or the given
 * fallback when it did not set one (an unmapped error becomes oRPC's generic per-code text).
 */
export function actionMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ORPCError) || !error.message) return fallback;
  if (!error.defined && error.message === fallbackORPCErrorMessage(error.code, undefined))
    return fallback;
  return error.message;
}
