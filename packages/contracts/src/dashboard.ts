import { oc } from "@orpc/contract";
import { z } from "zod";
import { MessageBlock } from "./events.js";
import { Id } from "./ids.js";
import { RunActivityRowSchema } from "./runs.js";
import { TeamRowSchema } from "./team.js";

export const UsagePeriodSchema = z.object({
  records: z.number().int().nonnegative(),
  // Distinct non-null saved run ids. Older servers omit these additive fields.
  runs: z.number().int().nonnegative().optional(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  // Complete cost only. Null when any record lacks pricing provenance.
  cost: z.number().nullable(),
  // Sum of priced records only; null when none are priced, never an assumed zero.
  knownCost: z.number().nullable().optional(),
  costStatus: z.enum(["complete", "partial", "unknown"]).optional(),
  pricingProvenance: z.array(z.unknown()).optional(),
  // True when a record in the period has input or output totals its provider did not
  // fully report; the token sums then cover the known part only. Older servers omit it.
  incomplete: z.boolean().optional(),
});
export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;
export const UsageSummarySchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  // Deprecated: historical record-count alias. Use records or runCount instead.
  runs: z.number(),
  // Distinct non-null saved run ids. Omitted by older servers.
  runCount: z.number().int().nonnegative().optional(),
  records: z.number().int().nonnegative().optional(),
  today: UsagePeriodSchema.optional(),
  week: UsagePeriodSchema.optional(),
  bots: z
    .array(
      z.object({
        botId: z.string().nullable(),
        name: z.string().nullable(),
        today: UsagePeriodSchema,
        week: UsagePeriodSchema,
        providers: z.array(
          z.object({
            provider: z.string(),
            today: UsagePeriodSchema,
            week: UsagePeriodSchema,
          }),
        ),
      }),
    )
    .optional(),
  dayStart: z.string().datetime(),
  weekStart: z.string().datetime(),
  asOf: z.string().datetime(),
  providers: z.array(
    z.object({
      provider: z.string(),
      today: UsagePeriodSchema,
      week: UsagePeriodSchema,
      daily: z.array(z.object({ date: z.string(), records: z.number(), tokens: z.number() })),
    }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const ConnectionOverviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["integration", "mcp", "device", "channel"]),
  state: z.enum(["connected", "needs-sign-in", "not-connected", "error"]),
  toolsNeedReview: z.boolean().optional(),
});
export type ConnectionOverview = z.infer<typeof ConnectionOverviewSchema>;
export const DashboardNowSchema = z.object({
  runs: z.array(RunActivityRowSchema),
  rows: z.array(TeamRowSchema),
  approvals: z.array(
    z.object({
      runId: Id,
      messageId: Id,
      block: MessageBlock.refine(
        (block) =>
          block.kind === "ask" && block.status !== "answered" && Boolean(block.approvalEffectId),
      ),
    }),
  ),
});
export type DashboardNow = z.infer<typeof DashboardNowSchema>;
export const dashboardContract = {
  now: oc.output(DashboardNowSchema),
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
