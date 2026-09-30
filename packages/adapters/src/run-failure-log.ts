import { redactMcpValue } from "@ardurbot/host-runtime/mcp-diagnostics";
import { getLogger, serializeError } from "@ardurbot/logging";

/** Failure summaries are content-free; all redacted diagnostics stay at debug. */
export function logRunFailure(
  message: string,
  error: unknown,
  secrets: readonly string[],
  facts: Record<string, unknown>,
): void {
  const logger = getLogger();
  logger.error(message, facts);
  const safe = redactMcpValue(serializeError(error), secrets);
  logger.debug(`${message} diagnostics: ${JSON.stringify(safe)}`);
}
