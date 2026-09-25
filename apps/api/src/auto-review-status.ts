import { autoReviewConfigurationWarning } from "@ardurbot/adapters";
import type { Logger } from "@ardurbot/logging";

let warned = false;

/** Report deployment misconfiguration once, never on each status poll or review. */
export function warnAutoReviewConfiguration(logger: Logger, env: NodeJS.ProcessEnv = process.env) {
  if (warned || !autoReviewConfigurationWarning(env)) return;
  warned = true;
  logger.warn("Jev needs a TypeSafe API key.");
}
