import type { HostLabel, TeamBoard, TeamRow } from "@ardurbot/contracts";
import { TeamBoardSchema } from "@ardurbot/contracts";
import { sortTeamRows, teamRowText } from "@ardurbot/core";
import { rpc } from "./api";
export async function loadTeamRows() {
  const board = TeamBoardSchema.parse(await rpc<TeamBoard>("team/board", {}));
  return { rows: sortTeamRows(board.rows), hostLabel: board.hostLabel };
}
/** A built-in target is named here, in the reader's language. The one source of truth for it. */
export function mobileTargetName<Name extends string | null | undefined>(
  target: { name: Name; builtin?: "host" | "local-docker" | "default" | null },
  translate: (text: string) => string,
  hostLabel?: HostLabel,
): Name | string {
  const mac = hostLabel === "This Mac";
  if (target.builtin === "host") return translate(mac ? "This Mac" : "This computer");
  if (target.builtin === "local-docker")
    return translate(mac ? "Docker on this Mac" : "Docker on this computer");
  if (target.builtin === "default") return translate("Default computer");
  return target.name;
}
export function mobileTeamRow(
  row: TeamRow,
  translate: (text: string) => string,
  hostLabel?: HostLabel,
) {
  const computerName = mobileTargetName(
    { name: row.computerName, builtin: row.computerBuiltin },
    translate,
    hostLabel,
  );
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
