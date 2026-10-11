import type { Actor, UsagePeriod, UsageSummary } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { Prisma } from "@ardurbot/db";

const DAY = 86_400_000;
export function usageWindows(now: Date) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const week = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
  return { day, week, from: new Date(day.getTime() - 6 * DAY) };
}

/** Database groups, never individual ledger records or one row per run. */
export type UsageAggregate = {
  kind: "total" | "provider" | "bot" | "bot-provider";
  botId: string | null;
  provider: string | null;
  window: string;
  records: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  knownCost: number | null;
  pricedRecords: number;
  pricingProvenance: unknown[];
  incomplete: boolean;
};

export function usagePeriod(row?: UsageAggregate): UsagePeriod {
  const records = row?.records ?? 0;
  const priced = row?.pricedRecords ?? 0;
  return {
    records,
    runs: row?.runs ?? 0,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    cost: records > 0 && priced === records ? row!.knownCost : null,
    knownCost: priced > 0 ? row!.knownCost : null,
    costStatus: priced === 0 ? "unknown" : priced === records ? "complete" : "partial",
    pricingProvenance: row?.pricingProvenance ?? [],
    incomplete: row?.incomplete ?? false,
  };
}

export function providerUsage(groups: UsageAggregate[], now: Date): UsageSummary["providers"] {
  const { from } = usageWindows(now);
  const providers = new Map<string, Map<string, UsageAggregate>>();
  for (const row of groups) {
    if (row.kind !== "provider" || row.provider === null) continue;
    if (!providers.has(row.provider)) providers.set(row.provider, new Map());
    providers.get(row.provider)!.set(row.window, row);
  }
  return [...providers]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, windows]) => ({
      provider,
      today: usagePeriod(windows.get("today")),
      week: usagePeriod(windows.get("week")),
      daily: Array.from({ length: 7 }, (_, index) => {
        const date = new Date(from.getTime() + index * DAY).toISOString().slice(0, 10);
        const row = windows.get(date);
        return {
          date,
          records: row?.records ?? 0,
          tokens: (row?.inputTokens ?? 0) + (row?.outputTokens ?? 0),
        };
      }),
    }));
}

/** GROUPING SETS count a run once per window even across bots, providers and UTC days. */
export function usageGroupsQuery(actor: Actor, now: Date) {
  const { day, week, from } = usageWindows(now);
  return Prisma.sql`
    WITH scoped AS (
      SELECT "botId", provider, "runId", "inputTokens", "outputTokens", cost,
        "pricingProvenance", "createdAt",
        (cost IS NOT NULL AND "pricingProvenance" IS NOT NULL
          AND jsonb_typeof("pricingProvenance") = 'object'
          AND "pricingProvenance" <> '{}'::jsonb) AS priced,
        ("categoryCoverage" IS NOT NULL AND "categoryCoverage" <> 'null'::jsonb AND (
          COALESCE("categoryCoverage"->>'logicalInput', '') <> 'complete'
          OR COALESCE("categoryCoverage"->>'output', '') <> 'complete'
          OR ("reasoningSemantics" = 'separate'
            AND COALESCE("categoryCoverage"->>'reasoning', '') <> 'complete')
        )) AS incomplete
      FROM usage_records
      WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
        AND "createdAt" >= ${from} AND "createdAt" <= ${now}
    ), windows AS (
      SELECT scoped.*, bucket.label
      FROM scoped CROSS JOIN LATERAL (
        SELECT 'today' AS label WHERE "createdAt" >= ${day}
        UNION ALL SELECT 'week' WHERE "createdAt" >= ${week}
        -- Prisma DateTime is stored as a UTC timestamp without time zone.
        -- Format it directly; converting to timestamptz would use the session zone.
        UNION ALL SELECT to_char("createdAt", 'YYYY-MM-DD')
      ) AS bucket
    )
    SELECT CASE
      WHEN GROUPING("botId") = 1 AND GROUPING(provider) = 1 THEN 'total'
      WHEN GROUPING("botId") = 1 THEN 'provider'
      WHEN GROUPING(provider) = 1 THEN 'bot'
      ELSE 'bot-provider' END AS kind,
      "botId", provider, label AS "window",
      COUNT(*)::int AS records, COUNT(DISTINCT "runId")::int AS runs,
      SUM("inputTokens")::float8 AS "inputTokens", SUM("outputTokens")::float8 AS "outputTokens",
      SUM(cost) FILTER (WHERE priced) AS "knownCost",
      COUNT(*) FILTER (WHERE priced)::int AS "pricedRecords",
      COALESCE(jsonb_agg(DISTINCT "pricingProvenance") FILTER (WHERE priced), '[]'::jsonb) AS "pricingProvenance",
      bool_or(incomplete) AS incomplete
    FROM windows
    GROUP BY GROUPING SETS ((label), (provider, label), ("botId", label), ("botId", provider, label))
  `;
}

export async function usageSummary(
  prisma: PrismaClient,
  actor: Actor,
  now = new Date(),
): Promise<UsageSummary> {
  const { day, week } = usageWindows(now);
  const [lifetime, groups] = await Promise.all([
    prisma.$queryRaw<
      { inputTokens: number; outputTokens: number; records: number; runCount: number }[]
    >(Prisma.sql`
      SELECT COALESCE(SUM("inputTokens"), 0)::float8 AS "inputTokens",
        COALESCE(SUM("outputTokens"), 0)::float8 AS "outputTokens",
        COUNT(*)::int AS records, COUNT(DISTINCT "runId")::int AS "runCount"
      FROM usage_records WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
    `),
    prisma.$queryRaw<UsageAggregate[]>(usageGroupsQuery(actor, now)),
  ]);
  const botGroups = groups.filter(
    (row) => row.kind === "bot" && ["today", "week"].includes(row.window),
  );
  const ids = [...new Set(botGroups.flatMap((row) => (row.botId === null ? [] : [row.botId])))];
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const [live, deleted] = ids.length
    ? await Promise.all([
        prisma.bot.findMany({
          where: { ...scope, id: { in: ids } },
          select: { id: true, name: true },
        }),
        // Deletion receipts lack an owner column; ids come exclusively from the scoped ledger.
        prisma.botDeletion.findMany({
          where: { spaceId: actor.spaceId, id: { in: ids } },
          select: { id: true, name: true },
        }),
      ])
    : [[], []];
  const names = new Map([...deleted, ...live].map((bot) => [bot.id, bot.name]));
  const byBot = new Map<string | null, Map<string, UsageAggregate>>();
  const byBotProvider = new Map<string | null, UsageAggregate[]>();
  for (const row of groups) {
    if (row.kind === "bot" && ["today", "week"].includes(row.window)) {
      if (!byBot.has(row.botId)) byBot.set(row.botId, new Map());
      byBot.get(row.botId)!.set(row.window, row);
    }
    if (row.kind === "bot-provider") {
      if (!byBotProvider.has(row.botId)) byBotProvider.set(row.botId, []);
      byBotProvider.get(row.botId)!.push({ ...row, kind: "provider" });
    }
  }
  return {
    ...lifetime[0]!,
    runs: lifetime[0]!.records,
    dayStart: day.toISOString(),
    weekStart: week.toISOString(),
    asOf: now.toISOString(),
    today: usagePeriod(groups.find((row) => row.kind === "total" && row.window === "today")),
    week: usagePeriod(groups.find((row) => row.kind === "total" && row.window === "week")),
    providers: providerUsage(groups, now),
    bots: [...byBot]
      .map(([botId, windows]) => ({
        botId,
        name: botId === null ? null : (names.get(botId) ?? null),
        today: usagePeriod(windows.get("today")),
        week: usagePeriod(windows.get("week")),
        providers: providerUsage(byBotProvider.get(botId) ?? [], now).map(
          ({ provider, today, week }) => ({ provider, today, week }),
        ),
      }))
      .sort((a, b) => (a.name ?? a.botId ?? "").localeCompare(b.name ?? b.botId ?? "")),
  };
}
