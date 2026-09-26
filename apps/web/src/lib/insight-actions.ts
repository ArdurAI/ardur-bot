import type { InsightAction } from "@ardurbot/contracts";

/** The shell opens the place an insight points to; the person makes the change there. */
export const INSIGHT_ACTION_EVENT = "ardur:insight-action";

export function openInsightAction(action: InsightAction) {
  window.dispatchEvent(new CustomEvent<InsightAction>(INSIGHT_ACTION_EVENT, { detail: action }));
}
