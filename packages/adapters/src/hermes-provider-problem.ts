import { failureCategoryMessage, RuntimePinError } from "@ardurbot/contracts";
import { listPiCatalog } from "./pi-models.js";

/** The worker owns the catalog; host messages need only the existing pinned provider id. */
export function nameHermesProviderFailure(error: unknown): unknown {
  if (!(error instanceof RuntimePinError) || error.problem.reasonId !== "provider-rate-limit")
    return error;
  const provider = error.problem.pin.provider;
  const name = listPiCatalog().find((entry) => entry.provider === provider)?.providerName;
  const named = new RuntimePinError({
    ...error.problem,
    reason: failureCategoryMessage("provider-rate-limit", {
      provider: name ?? provider ?? "This connection",
    }),
  });
  if (error.cause !== undefined) named.cause = error.cause;
  return named;
}
