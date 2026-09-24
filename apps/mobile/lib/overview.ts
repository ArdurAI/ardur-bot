import type {
  ConnectionOverview,
  RunsListOutput,
  TeamBoard,
  UsageSummary,
} from "@ardurbot/contracts";
import {
  ConnectionOverviewSchema,
  RunsListOutputSchema,
  TeamBoardSchema,
  UsageSummarySchema,
} from "@ardurbot/contracts";
import type { OverviewNow } from "@ardurbot/core";
import { rpc } from "./api";

export async function loadOverviewNow(): Promise<OverviewNow> {
  const [runs, team] = await Promise.all([
    rpc<RunsListOutput>("runs/list", { filter: "active" }),
    rpc<TeamBoard>("team/board", {}),
  ]);
  return { runs: RunsListOutputSchema.parse(runs).runs, rows: TeamBoardSchema.parse(team).rows };
}
export async function loadOverviewConnections() {
  return ConnectionOverviewSchema.array().parse(
    await rpc<ConnectionOverview[]>("dashboard/connections"),
  );
}
export async function loadOverviewUsage() {
  return UsageSummarySchema.parse(await rpc<UsageSummary>("usage/summary"));
}
