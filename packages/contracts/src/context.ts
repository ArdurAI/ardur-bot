import { z } from "zod";

export const ContextBudgetsSchema = z.object({
  stable: z.number().int().min(4000).max(64000).default(64000),
  brief: z.number().int().min(200).max(6000).default(6000),
  summary: z.number().int().min(200).max(12000).default(4000),
  messages: z.number().int().min(1000).max(48000).default(12000),
  recall: z.number().int().min(200).max(12000).default(6000),
  message: z.number().int().min(1000).max(128000).default(48000),
});
export const DEFAULT_CONTEXT_BUDGETS = ContextBudgetsSchema.parse({});
export type ContextBudgets = z.infer<typeof ContextBudgetsSchema>;
export const RoutingRuleSchema = z.enum([
  "mention",
  "reply",
  "group-coordinator",
  "last-active-thread",
  "space-coordinator",
  "default",
]);
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;
export const ConcurrentRunsSchema = z.number().int().min(1).max(16);
export const ContextSettingsSchema = z.object({
  budgets: ContextBudgetsSchema,
  concurrentRuns: ConcurrentRunsSchema,
  spaceConcurrentRuns: ConcurrentRunsSchema,
  coordinatorBotId: z.string().nullable(),
});
const measured = z.number().nonnegative().nullable();
const characters = z.number().int().nonnegative();
export const ContextSnapshotSchema = z.object({
  layers: z.object({
    stable: characters,
    brief: characters,
    summary: characters,
    messages: characters,
    recall: characters,
    message: characters,
  }),
  recallRan: z.boolean(),
  recallCalls: z.number().int().nonnegative(),
  cachedTokens: measured,
  inputTokens: measured,
  timeToFirstTokenMs: measured,
  queueWaitMs: measured,
  routingRule: RoutingRuleSchema.nullable(),
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export const ContextAggregateSchema = z.object({
  botId: z.string(),
  groupId: z.string().nullable(),
  runs: z.number(),
  measuredFirstTokenRuns: z.number(),
  measuredCacheRuns: z.number(),
  timeToFirstTokenP50Ms: measured,
  timeToFirstTokenP95Ms: measured,
  averagePromptCharacters: measured,
  cacheHitRatio: measured,
  queueWaitP50Ms: measured,
  queueWaitP95Ms: measured,
  recallCalls: z.number(),
});
export type ContextAggregate = z.infer<typeof ContextAggregateSchema>;
export const ContextMetricsSchema = z.object({
  today: z.array(ContextAggregateSchema),
  sevenDays: z.array(ContextAggregateSchema),
});
export const BriefSchema = z.object({
  botId: z.string(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  threadId: z.string(),
  documentId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  content: z.string().max(6000),
  rewrittenAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export type Brief = z.infer<typeof BriefSchema>;
