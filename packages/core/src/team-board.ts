import type { TeamRow } from "@ardurbot/contracts";
import { failureCategory } from "@ardurbot/contracts";
import { presenceFreshness } from "./bot-presence.js";
export const TEAM_REFRESH_MS = 15000;
const priority: Record<TeamRow["state"], number> = {
  "waiting-approval": 0,
  blocked: 1,
  working: 2,
  queued: 3,
  completed: 4,
  accepted: 5,
  idle: 6,
};
export function sortTeamRows(rows: TeamRow[]) {
  return [...rows].sort(
    (a, b) =>
      priority[a.state] - priority[b.state] ||
      a.botName.localeCompare(b.botName) ||
      a.botId.localeCompare(b.botId),
  );
}
/** Identity translation that still substitutes a category sentence's named placeholders. */
const identityTranslate = (text: string, values?: Record<string, string | number>): string =>
  values
    ? text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
        Object.hasOwn(values, key) ? String(values[key]) : match,
      )
    : text;
export function teamRowText(
  row: TeamRow,
  t: (text: string, values?: Record<string, string | number>) => string = identityTranslate,
  now = Date.now(),
): string {
  if (
    row.state !== "blocked" &&
    row.state !== "waiting-approval" &&
    (row.availability === "unknown" ||
      row.availability === "unavailable" ||
      (row.observedAt && presenceFreshness(row.observedAt, now) === "unavailable"))
  )
    return t("Status unavailable");
  const title = row.currentTaskTitle ?? row.sentence;
  switch (row.state) {
    case "idle":
      return t("Idle");
    case "queued":
      return t("Queued");
    case "working":
      return title
        ? `${t("Working on")} ${title}${(row.activeRunCount ?? 0) > 1 ? ` · ${row.activeRunCount} ${t("active tasks")}` : ""}`
        : t("Working");
    case "waiting-approval":
      return t("Waiting for approval");
    case "blocked": {
      // A categorized reason comes from the failure-category table so the app can
      // translate it; anything else is the recorded text.
      const reason = row.reasonCategory
        ? t(failureCategory(row.reasonCategory).message, {
            runtime: row.reasonRuntime ?? t("This runtime"),
          })
        : (row.reason ?? t("The task needs attention"));
      return `${t("Blocked")} — ${reason}`;
    }
    case "completed":
      return t("Done — waiting for your OK");
    case "accepted":
      return t("Accepted");
  }
}

export function teamDeliveryText(state: string, t: (text: string) => string = (text) => text) {
  switch (state) {
    case "held":
      return t("Waiting for your approval");
    case "queued":
      return t("Waiting for a turn");
    case "delivered":
      return t("Delivered");
    case "read":
      return t("Read");
    case "replied":
      return t("Replied");
    case "denied":
      return t("Not approved");
    case "expired":
      return t("Expired");
    case "cancelled":
      return t("Cancelled");
    case "failed":
      return t("Failed");
    default:
      return t("Status unavailable");
  }
}
