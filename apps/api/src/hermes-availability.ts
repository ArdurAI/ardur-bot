import type { ModelCredential } from "@ardurbot/contracts";
import { HERMES_HOST_MAX_OUTPUT_TOKENS } from "@ardurbot/contracts";

/** Availability must not advertise a connection whose output cap the host rejects. */
export function hermesAvailabilityConnectionSupported(
  credential: Pick<ModelCredential, "maxTokens">,
): boolean {
  return (
    credential.maxTokens === undefined ||
    (Number.isSafeInteger(credential.maxTokens) &&
      credential.maxTokens > 0 &&
      credential.maxTokens <= HERMES_HOST_MAX_OUTPUT_TOKENS)
  );
}
