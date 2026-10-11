import { t } from "@lingui/core/macro";

/** Translate only known selection refusals; preserve other server diagnostics. */
export function modelSelectionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  switch (error.message) {
    case "Connect that model first.":
      return t`Connect that model first.`;
    case "Choose a model.":
      return t`Choose a model.`;
    case "Connect that model server first.":
      return t`Connect that model server first.`;
    case "This connection cannot serve that model.":
      return t`This connection cannot serve that model.`;
    case "Unknown model for that provider":
      return t`Unknown model for that provider`;
    default:
      return error.message;
  }
}
