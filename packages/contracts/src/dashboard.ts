import { oc } from "@orpc/contract";
import { z } from "zod";

export const UsagePeriodSchema = z.object({
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  // Null when any request lacks a reported cost with pricing provenance.
  cost: z.number().nullable(),
});
export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;
export const UsageSummarySchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  runs: z.number(),
  dayStart: z.string().datetime(),
  weekStart: z.string().datetime(),
  asOf: z.string().datetime(),
  providers: z.array(
    z.object({
      provider: z.string(),
      today: UsagePeriodSchema,
      week: UsagePeriodSchema,
      daily: z.array(z.object({ date: z.string(), requests: z.number(), tokens: z.number() })),
    }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const ConnectionOverviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["integration", "mcp", "device", "channel"]),
  state: z.enum(["connected", "needs-sign-in", "not-connected", "error"]),
});
export type ConnectionOverview = z.infer<typeof ConnectionOverviewSchema>;
export const dashboardContract = {
  connections: oc.output(z.array(ConnectionOverviewSchema)),
};

const RoutineOverviewEntrySchema = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  at: z.string().datetime(),
});
export const RoutineOverviewSchema = z.object({
  next: z.array(RoutineOverviewEntrySchema),
  recent: z.array(
    RoutineOverviewEntrySchema.extend({
      runId: z.string(),
      status: z.string(),
    }),
  ),
});
export type RoutineOverview = z.infer<typeof RoutineOverviewSchema>;
