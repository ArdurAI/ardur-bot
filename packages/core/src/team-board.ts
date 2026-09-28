import type { TeamRow } from "@ardurbot/contracts";
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
export function teamRowText(
  row: TeamRow,
  t: (text: string) => string = (text) => text,
  now = Date.now(),
): string {
  if (
    row.availability === "unknown" ||
    row.availability === "unavailable" ||
    (row.observedAt && presenceFreshness(row.observedAt, now) === "unavailable")
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
    case "blocked":
      return `${t("Blocked")} — ${row.reason ?? t("The task needs attention")}`;
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
