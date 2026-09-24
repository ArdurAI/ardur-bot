import type { TeamRow } from "@ardurbot/contracts";
export const TEAM_REFRESH_MS = 5000;
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
export function teamRowText(row: TeamRow, t: (text: string) => string = (text) => text): string {
  switch (row.state) {
    case "idle":
      return t("Idle");
    case "queued":
      return t("Queued");
    case "working":
      return row.sentence
        ? `${t("Working on")} ${row.sentence}${row.requesterName ? ` ${t("for")} ${row.requesterName}` : ""}`
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
