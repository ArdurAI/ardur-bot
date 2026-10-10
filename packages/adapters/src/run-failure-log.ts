import type { RuntimeFailure } from "@ardurbot/contracts/runtime-pins";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import { detailedProcessLogsEnabled } from "@ardurbot/host-runtime/child-output";
import { redactMcpValue } from "@ardurbot/host-runtime/mcp-diagnostics";
import { getLogger, serializeError } from "@ardurbot/logging";

/** Bounded runtime diagnostics are redacted; general error causes require debug opt-in. */
export function logRunFailure(
  message: string,
  error: unknown,
  secrets: readonly string[],
  facts: Record<string, unknown>,
): void {
  const logger = getLogger();
  if (error instanceof RuntimePinError && error.problem.failure) {
    const safe = redactMcpValue(error.problem.failure, secrets) as RuntimeFailure;
    // Message bindings are suppressed by the general logger. Use its redacted Error
    // channel for this bounded diagnostic; never relax the binding redaction rules.
    const diagnostic = new Error(safe.message);
    diagnostic.name = safe.errorClass;
    diagnostic.stack = undefined;
    const { message: _message, ...metadata } = safe;
    logger.error(message, diagnostic, { ...facts, runtimeFailure: metadata });
  } else logger.error(message, facts);
  if (!detailedProcessLogsEnabled()) return;
  const safe = redactMcpValue(serializeError(error), secrets);
  logger.debug(`${message} diagnostics: ${JSON.stringify(safe)}`);
}
