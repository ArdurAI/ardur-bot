import type { ComparisonResult } from "@ardurbot/contracts";

export function comparisonStatusText(
  result: ComparisonResult,
  translate: (text: string) => string,
) {
  switch (result.status) {
    case "waiting-approval":
      return translate("Waiting for approval");
    case "failed":
      return `${translate("Failed")} — ${result.failure ?? translate("Not reported")}`;
    case "queued":
      return translate("Queued");
    case "running":
      return translate("Running");
    case "completed":
      return translate("Completed");
    case "cancelled":
      return translate("Cancelled");
    case "incomplete":
      return translate("Incomplete");
  }
}
