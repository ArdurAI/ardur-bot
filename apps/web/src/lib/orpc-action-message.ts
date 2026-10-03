import { HERMES_CONTEXT_LIMIT_MESSAGE } from "@ardurbot/contracts";
import { rpcErrorMessage } from "@ardurbot/core";
import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";

/**
 * The server's own sentence when a request failed for a reason worth saying, or the given
 * fallback. Its code decides: an error the server did not map never shows its text.
 */
export function actionMessage(error: unknown, fallback: string): string {
  const message = error instanceof ORPCError ? rpcErrorMessage(error, fallback) : fallback;
  return message === HERMES_CONTEXT_LIMIT_MESSAGE ? i18n._(HERMES_CONTEXT_LIMIT_MESSAGE) : message;
}
