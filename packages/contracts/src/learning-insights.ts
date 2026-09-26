import * as z from "zod";
import { Id } from "./ids.js";

/** Coarse task classes, derived from what a run did. */
export const InsightTaskKindSchema = z.enum(["coding", "research", "routine", "conversation"]);
export type InsightTaskKind = z.infer<typeof InsightTaskKindSchema>;

/** A model and effort as the person's runs used it. `local` means it ran on this machine. */
export const InsightModelSchema = z.object({
  key: z.string(),
  label: z.string(),
  local: z.boolean(),
});
export type InsightModel = z.infer<typeof InsightModelSchema>;

export const InsightModelRowSchema = z.object({
  model: InsightModelSchema,
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  thumbsUp: z.number().int().nonnegative(),
  thumbsDown: z.number().int().nonnegative(),
  medianMs: z.number().int().nonnegative().nullable(),
  medianTokens: z.number().int().nonnegative().nullable(),
  /** Only when every usage record behind these runs carried a price with provenance. */
  costUsd: z.number().nonnegative().nullable(),
});
export type InsightModelRow = z.infer<typeof InsightModelRowSchema>;

const windowed = { runs: z.number().int().nonnegative(), days: z.number().int().positive() };

export const InsightEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model-choice"),
    variant: z.enum(["completion", "local", "tokens", "time"]),
    taskKind: InsightTaskKindSchema,
    botName: z.string(),
    better: InsightModelSchema,
    other: InsightModelSchema,
    rows: z.array(InsightModelRowSchema),
    ...windowed,
  }),
  z.object({
    kind: z.literal("repeated-failure"),
    failure: z.enum(["tools", "context", "rate-limit", "credential"]),
    botName: z.string(),
    model: InsightModelSchema,
    streak: z.number().int().positive(),
    suggested: InsightModelSchema.nullable(),
    /** Completed runs of the suggestion in the window (tools and rate limits). */
    suggestedRuns: z.number().int().nonnegative().optional(),
    contextWindow: z.number().int().positive().optional(),
    suggestedContextWindow: z.number().int().positive().optional(),
    ...windowed,
  }),
  z.object({
    kind: z.literal("connection"),
    problem: z.enum(["rejected", "missing"]),
    connection: z.string(),
    ...windowed,
  }),
  z.object({
    kind: z.literal("memory-search"),
    documents: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("learning-off"),
    reasons: z.number().int().nonnegative(),
    days: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("approval"),
    botName: z.string(),
    tool: z.string(),
    approvals: z.number().int().positive(),
    days: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("routine"),
    botName: z.string(),
    prompt: z.string(),
    count: z.number().int().positive(),
    days: z.number().int().positive(),
  }),
]);
export type InsightEvidence = z.infer<typeof InsightEvidenceSchema>;
export type InsightKind = InsightEvidence["kind"];

/** Where the person acts. An insight never changes anything itself. */
export const InsightActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot-model"), botId: Id }),
  z.object({
    kind: z.literal("connection"),
    provider: z.string(),
    credentialId: z.string().optional(),
  }),
  z.object({ kind: z.literal("memory-settings") }),
  z.object({ kind: z.literal("learning-settings") }),
  z.object({ kind: z.literal("approval-rule"), botId: Id, tool: z.string().min(1) }),
  z.object({ kind: z.literal("routine"), botId: Id, prompt: z.string().min(1) }),
]);
export type InsightAction = z.infer<typeof InsightActionSchema>;

export const InsightStatusSchema = z.enum(["active", "dismissed", "acted", "expired"]);
export type InsightStatus = z.infer<typeof InsightStatusSchema>;

export const LearningInsightSchema = z.object({
  id: Id,
  botId: z.string().nullable(),
  status: InsightStatusSchema,
  evidence: InsightEvidenceSchema,
  action: InsightActionSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type LearningInsight = z.infer<typeof LearningInsightSchema>;

export const LearningInsightsSchema = z.object({
  insights: z.array(LearningInsightSchema),
});

/** Insights about the space's setup, shown only to the space owner. */
export const SPACE_INSIGHT_KINDS: readonly InsightKind[] = ["memory-search", "learning-off"];
