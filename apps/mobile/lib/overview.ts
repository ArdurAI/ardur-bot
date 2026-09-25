import type { ConnectionOverview, DashboardNow, UsageSummary } from "@ardurbot/contracts";
import {
  ConnectionOverviewSchema,
  DashboardNowSchema,
  UsageSummarySchema,
} from "@ardurbot/contracts/dashboard";
import { rpc } from "./api";

export async function loadOverviewNow(): Promise<DashboardNow> {
  return DashboardNowSchema.parse(await rpc<DashboardNow>("dashboard/now"));
}
export async function loadOverviewConnections() {
  return ConnectionOverviewSchema.array().parse(
    await rpc<ConnectionOverview[]>("dashboard/connections"),
  );
}
export async function loadOverviewUsage() {
  return UsageSummarySchema.parse(await rpc<UsageSummary>("usage/summary"));
}
