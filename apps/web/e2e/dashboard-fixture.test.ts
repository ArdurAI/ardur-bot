import { UsageSummarySchema } from "@ardurbot/contracts/dashboard";
import { expect, it } from "vitest";
import { dashboardFixture } from "./dashboard-fixture";

it("keeps the usage screenshot fixture consistent across totals, bot and provider rows", () => {
  const value = UsageSummarySchema.parse(dashboardFixture().rpc("usage/summary"));
  expect(value).toMatchObject({
    records: 3,
    runs: 3,
    runCount: 1,
    today: { records: 3, runs: 1, cost: null, knownCost: 0.2, costStatus: "partial" },
  });
  expect(value.bots?.[0]?.today).toEqual(value.today);
  expect(value.providers[0]?.today).toEqual(value.today);
  expect(value.bots?.[0]?.providers[0]?.week).toEqual(value.week);
  expect(value.providers[0]?.daily.reduce((sum, row) => sum + row.records, 0)).toBe(value.records);
});
