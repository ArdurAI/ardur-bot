/**
 * Codes the server raises with a sentence of its own for people, such as a busy board or a bot
 * that cannot reach it. Any other code carries only generic text: INTERNAL_SERVER_ERROR above
 * all, which is what every error the server did not map becomes.
 */
const USER_FACING_RPC_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
]);

/**
 * The server's sentence for a failed request, or the caller's fallback when the error's code
 * has none. A bare error with a user-facing code carries only that code in words ("Forbidden",
 * "Not Found"), so it falls back too.
 */
export function rpcErrorMessage(
  error: { code?: string; message: string },
  fallback: string,
): string {
  if (!error.code || !USER_FACING_RPC_CODES.has(error.code) || !error.message) return fallback;
  return error.message.trim().toUpperCase().replace(/\s+/g, "_") === error.code
    ? fallback
    : error.message;
}
