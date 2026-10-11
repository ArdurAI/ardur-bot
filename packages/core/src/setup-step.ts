import type { Me } from "@ardurbot/contracts";

export type SetupReadResult<T> =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; value: T };

export type SetupStep =
  | "loading"
  | "account-error"
  | "catalog-error"
  | "model"
  | "integrations"
  | "bot";

/** Failed reads are unknown setup state, never permission to create the first bot. */
export function setupStep(
  account: SetupReadResult<Pick<Me, "needsModel">>,
  catalog: SetupReadResult<unknown>,
  needsIntegrationSetup = false,
): SetupStep {
  if (account.status === "failed") return "account-error";
  if (account.status === "loading") return "loading";
  if (catalog.status === "failed") return "catalog-error";
  if (catalog.status === "loading") return "loading";
  if (account.value.needsModel) return "model";
  return needsIntegrationSetup ? "integrations" : "bot";
}
