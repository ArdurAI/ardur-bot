import type { HostLabel, TeamBoard, TeamRow } from "@ardurbot/contracts";
import { TeamBoardSchema } from "@ardurbot/contracts";
import { sortTeamRows, teamRowText } from "@ardurbot/core";
import { rpc } from "./api";
export async function loadTeamRows() {
  const board = TeamBoardSchema.parse(await rpc<TeamBoard>("team/board", {}));
  return { rows: sortTeamRows(board.rows), hostLabel: board.hostLabel };
}
/** A computer without a saved connection is named here, in the reader's language. */
export function mobileTeamRow(
  row: TeamRow,
  translate: (text: string) => string,
  hostLabel?: HostLabel,
) {
  const mac = hostLabel === "This Mac";
  const computerName =
    row.computerBuiltin === "host"
      ? translate(mac ? "This Mac" : "This computer")
      : row.computerBuiltin === "local-docker"
        ? translate(mac ? "Docker on this Mac" : "Docker on this computer")
        : row.computerName;
  return {
    id: row.botId,
    name: row.botName,
    text: teamRowText(row, translate),
    computerName,
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
