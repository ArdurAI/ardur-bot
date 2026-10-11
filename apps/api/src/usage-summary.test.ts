import type { Actor } from "@ardurbot/contracts";
import { UsageSummarySchema } from "@ardurbot/contracts/dashboard";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import type { UsageAggregate } from "./usage-summary.js";
import {
  providerUsage,
  usageGroupsQuery,
  usagePeriod,
  usageSummary,
  usageWindows,
} from "./usage-summary.js";

const now = new Date("2026-09-24T12:00:00Z");
const actor = { spaceId: "space", userId: "member" } as Actor;
const group = (overrides: Partial<UsageAggregate> = {}): UsageAggregate => ({
  kind: "provider",
  botId: null,
  provider: "fixture",
  window: "today",
  records: 3,
  runs: 1,
  inputTokens: 120,
  outputTokens: 15,
  knownCost: null,
  pricedRecords: 0,
  pricingProvenance: [],
  incomplete: false,
  ...overrides,
});

describe("usage aggregates", () => {
  it("keeps several records in one run separate from the distinct run count", () => {
    expect(usagePeriod(group())).toMatchObject({
      records: 3,
      runs: 1,
      inputTokens: 120,
      outputTokens: 15,
    });
    // A totals-only record may combine many calls; neither records nor runs estimates requests.
    expect(usagePeriod(group({ records: 1, runs: 1, inputTokens: 600 }))).not.toHaveProperty(
      "requests",
    );
    expect(usagePeriod(group({ runs: 0 })).runs).toBe(0);
  });
  it("does not add cached categories to the canonical input token sum a second time", () => {
    // The writer already includes 80 read + 15 write + 25 uncached in its 120 input total.
    expect(usagePeriod(group())).toMatchObject({
      inputTokens: 120,
      outputTokens: 15,
      incomplete: false,
    });
  });
  it("keeps missing prices and prices without provenance unknown, including empty periods", () => {
    for (const value of [group(), group({ knownCost: 99 }), undefined]) {
      expect(usagePeriod(value)).toMatchObject({
        cost: null,
        knownCost: null,
        costStatus: "unknown",
        pricingProvenance: [],
      });
    }
    expect(usagePeriod()).toMatchObject({ records: 0, runs: 0, inputTokens: 0, outputTokens: 0 });
  });
  it("returns the known subtotal and sources while complete cost remains null for partial pricing", () => {
    const pricingProvenance = [{ kind: "reported" }, { kind: "request-observations" }];
    expect(
      usagePeriod(group({ pricedRecords: 2, knownCost: 0.3, pricingProvenance })),
    ).toMatchObject({
      cost: null,
      knownCost: 0.3,
      costStatus: "partial",
      pricingProvenance,
    });
    expect(usagePeriod(group({ pricedRecords: 3, knownCost: 0, pricingProvenance }))).toMatchObject(
      {
        cost: 0,
        knownCost: 0,
        costStatus: "complete",
        pricingProvenance,
      },
    );
  });
  it("preserves incomplete token reporting separately from incomplete pricing", () => {
    expect(
      usagePeriod(group({ incomplete: true, pricedRecords: 3, knownCost: 0.3 })),
    ).toMatchObject({ incomplete: true, costStatus: "complete" });
  });
  it("uses UTC midnight, Monday, and seven calendar days, including a Sunday and Monday", () => {
    expect(usageWindows(now)).toEqual({
      day: new Date("2026-09-24T00:00:00Z"),
      week: new Date("2026-09-21T00:00:00Z"),
      from: new Date("2026-09-18T00:00:00Z"),
    });
    expect(usageWindows(new Date("2026-09-27T23:59:59.999Z")).week.toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
    expect(usageWindows(new Date("2026-09-28T00:00:00Z")).week.toISOString()).toBe(
      "2026-09-28T00:00:00.000Z",
    );
  });
  it("uses independent database period counts rather than summing daily distinct run counts", () => {
    const [result] = providerUsage(
      [
        group(),
        group({ window: "week", runs: 1, records: 4 }),
        group({ window: "2026-09-23", records: 1 }),
        group({ window: "2026-09-24", records: 3 }),
      ],
      now,
    );
    expect(result?.week.runs).toBe(1);
    expect(result?.daily.map((row) => row.records)).toEqual([0, 0, 0, 0, 0, 1, 3]);
    expect(result?.today.records).toBe(3);
  });
  it("binds actor and inclusive date boundaries and performs distinct counting and grouping in SQL", () => {
    const query = usageGroupsQuery(actor, now);
    expect(query.values).toEqual([
      actor.spaceId,
      actor.userId,
      new Date("2026-09-18T00:00:00Z"),
      now,
      new Date("2026-09-24T00:00:00Z"),
      new Date("2026-09-21T00:00:00Z"),
    ]);
    expect(query.text).toContain('COUNT(DISTINCT "runId")');
    expect(query.text).toContain("GROUP BY GROUPING SETS");
    expect(query.text).toContain('"createdAt" >=');
    expect(query.text).toContain('"createdAt" <=');
    expect(query.text).toContain(`to_char("createdAt", 'YYYY-MM-DD')`);
    expect(query.text).not.toContain("AT TIME ZONE");
    expect(query.text).not.toContain(actor.userId);
  });
  it("returns scoped bot and provider periods, deletion names, and lifetime record and run counts", async () => {
    const groups = [
      group({ kind: "total", provider: null }),
      group({ kind: "total", provider: null, window: "week" }),
      group(),
      group({ window: "week" }),
      group({ kind: "bot", botId: "live", provider: null }),
      group({ kind: "bot", botId: "removed", provider: null, window: "week" }),
      group({ kind: "bot", botId: null, provider: null }),
      group({ kind: "bot-provider", botId: "live" }),
      group({ kind: "bot-provider", botId: "live", window: "week" }),
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ inputTokens: 999, outputTokens: 5, records: 9, runCount: 2 }])
      .mockResolvedValueOnce(groups);
    const live = vi.fn(async () => [{ id: "live", name: "Reviewer" }]);
    const deleted = vi.fn(async () => [{ id: "removed", name: "Archived reviewer" }]);
    const result = await usageSummary(
      {
        $queryRaw: query,
        bot: { findMany: live },
        botDeletion: { findMany: deleted },
      } as unknown as PrismaClient,
      actor,
      now,
    );
    expect(result).toMatchObject({
      records: 9,
      runs: 9,
      runCount: 2,
      inputTokens: 999,
      today: { runs: 1 },
      week: { runs: 1 },
    });
    expect(result.bots?.map((bot) => bot.name)).toEqual([null, "Archived reviewer", "Reviewer"]);
    expect(result.bots?.find((bot) => bot.botId === "live")?.providers[0]).toMatchObject({
      provider: "fixture",
      today: { records: 3, runs: 1 },
      week: { records: 3, runs: 1 },
    });
    expect(live).toHaveBeenCalledWith({
      where: { ...actor, id: { in: ["live", "removed"] } },
      select: { id: true, name: true },
    });
    expect(deleted).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId, id: { in: ["live", "removed"] } },
      select: { id: true, name: true },
    });
    expect(query.mock.calls[0]![0].values).toEqual([actor.spaceId, actor.userId]);
    expect(UsageSummarySchema.safeParse(result).success).toBe(true);
  });
  it("accepts older server payloads without inventing new counts or cost coverage", () => {
    expect(
      UsageSummarySchema.parse({
        inputTokens: 0,
        outputTokens: 0,
        runs: 0,
        providers: [],
        dayStart: now.toISOString(),
        weekStart: now.toISOString(),
        asOf: now.toISOString(),
      }),
    ).not.toHaveProperty("records");
  });
});
