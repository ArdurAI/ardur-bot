import { teamDeliveryText } from "@ardurbot/core";
import { t } from "@lingui/core/macro";

/** Static IDs keep shared delivery labels in the extracted web catalogs. */
export function localizedTeamDeliveryText(state: string): string {
  const labels: Record<string, string> = {
    "Waiting for a turn": t`Waiting for a turn`,
    Delivered: t`Delivered`,
    Read: t`Read`,
    Replied: t`Replied`,
    "Not approved": t`Not approved`,
    Expired: t`Expired`,
    Cancelled: t`Cancelled`,
    Failed: t`Failed`,
    "Status unavailable": t`Status unavailable`,
  };
  return teamDeliveryText(state, (label) => labels[label] ?? label);
}
