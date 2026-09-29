import { expect, it, vi } from "vitest";
import { rpc } from "./api";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";
import { loadOverviewConnections, loadOverviewNow, loadOverviewUsage } from "./overview";

vi.mock("./api", () => ({ rpc: vi.fn() }));
it("uses the shared read RPCs and validates their contracts", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) => {
    if (procedure === "dashboard/now") return { runs: [], rows: [], approvals: [] };
    if (procedure === "dashboard/connections") return [];
    return {
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
      dayStart: "2026-09-24T00:00:00Z",
      weekStart: "2026-09-21T00:00:00Z",
      asOf: "2026-09-24T12:00:00Z",
      providers: [],
    };
  });
  expect(await loadOverviewNow()).toEqual({ rows: [], runs: [], approvals: [] });
  expect(await loadOverviewConnections()).toEqual([]);
  expect(await loadOverviewUsage()).toMatchObject({ providers: [] });
  expect(vi.mocked(rpc).mock.calls.map(([procedure]) => procedure)).toEqual([
    "dashboard/now",
    "dashboard/connections",
    "usage/summary",
  ]);
  vi.mocked(rpc).mockResolvedValue([
    { id: "untrusted", name: "Fixture", kind: "device", state: "invented" },
  ]);
  await expect(loadOverviewConnections()).rejects.toThrow();
});

it("loads Usage from a server that predates the partially reported marker", async () => {
  const period = { records: 2, inputTokens: 30, outputTokens: 12, cost: null };
  vi.mocked(rpc).mockResolvedValue({
    inputTokens: 30,
    outputTokens: 12,
    runs: 2,
    dayStart: "2026-09-24T00:00:00Z",
    weekStart: "2026-09-21T00:00:00Z",
    asOf: "2026-09-24T12:00:00Z",
    providers: [{ provider: "fixture", today: period, week: period, daily: [] }],
  });
  const usage = await loadOverviewUsage();
  expect(usage.providers[0]?.today).toEqual(period);
  expect(usage.providers[0]?.week.incomplete).toBeUndefined();
});

it("translates every Overview string in every non-English mobile catalog", () => {
  const source = readFileSync(new URL("../app/overview.tsx", import.meta.url), "utf8");
  const ids = [...source.matchAll(/\bt\(\s*"((?:\\.|[^"\\])*)"/g)].map(
    (match) => JSON.parse(`"${match[1]}"`) as string,
  );
  expect(ids).toContain("Overview");
  for (const messages of [ZH_MESSAGES, RU_MESSAGES]) {
    expect(ids.filter((id) => !messages[id]?.trim())).toEqual([]);
  }
});

import { readFileSync } from "node:fs";
