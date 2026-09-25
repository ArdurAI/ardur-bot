import { expect, it, vi } from "vitest";
import { rpc } from "./api";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";
import { loadOverviewConnections, loadOverviewNow, loadOverviewUsage } from "./overview";

vi.mock("./api", () => ({ rpc: vi.fn() }));
it("uses the shared read RPCs and validates their contracts", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) => {
    if (procedure === "runs/list") return { runs: [] };
    if (procedure === "team/board") return { rows: [] };
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
  expect(await loadOverviewNow()).toEqual({ rows: [], runs: [] });
  expect(await loadOverviewConnections()).toEqual([]);
  expect(await loadOverviewUsage()).toMatchObject({ providers: [] });
  expect(vi.mocked(rpc).mock.calls.map(([procedure]) => procedure)).toEqual([
    "runs/list",
    "team/board",
    "dashboard/connections",
    "usage/summary",
  ]);
  vi.mocked(rpc).mockResolvedValue([
    { id: "untrusted", name: "Fixture", kind: "device", state: "invented" },
  ]);
  await expect(loadOverviewConnections()).rejects.toThrow();
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
