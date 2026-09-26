import { rpcErrorMessage } from "@ardurbot/core";
import { ORPCError } from "@orpc/client";

/**
 * The server's own sentence when a request failed for a reason worth saying, or the given
 * fallback. Its code decides: an error the server did not map never shows its text.
 */
export function actionMessage(error: unknown, fallback: string): string {
  return error instanceof ORPCError ? rpcErrorMessage(error, fallback) : fallback;
}
