import type { TeamBoard, TeamRow } from "@ardurbot/contracts";
import { TeamBoardSchema } from "@ardurbot/contracts";
import { sortTeamRows, teamRowText } from "@ardurbot/core";
import { rpc } from "./api";
export async function loadTeamRows() {
  return sortTeamRows(TeamBoardSchema.parse(await rpc<TeamBoard>("team/board", {})).rows);
}
export function mobileTeamRow(row: TeamRow, translate: (text: string) => string) {
  return {
    id: row.botId,
    name: row.botName,
    text: teamRowText(row, translate),
    stop: row.canStop,
    accept: row.canAccept,
  };
}
export async function stopTeamTask(row: TeamRow) {
  if (!row.canStop || !row.rootTaskId) return;
  await rpc("delegations/cancel", { rootTaskId: row.rootTaskId });
}
export async function acceptTeamTask(row: TeamRow) {
  if (!row.canAccept || !row.delegationId) return;
  await rpc("delegations/accept", { id: row.delegationId });
}
