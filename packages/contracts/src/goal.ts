import { oc } from "@orpc/contract";
import * as z from "zod";
import { DEFAULT_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "./domain.js";
import { Id, IsoDate } from "./ids.js";

/** Largest one-request floor: the standard prompt allowance plus the largest output cap. */
export const GOAL_MAX_PER_WORKER_TOKENS = DEFAULT_MODEL_CONTEXT_WINDOW + MAX_MODEL_MAX_TOKENS;

export const GOAL_DEFAULT_TOKEN_LIMIT = 600_000;
/**
 * Covers one realistic worker request for a reasoning model: a full standard context
 * (DEFAULT_MODEL_CONTEXT_WINDOW) plus one reasoning output (REASONING_MODEL_MAX_TOKENS),
 * which is the admission floor minimumDelegationReservation computes for such a worker.
 */
export const GOAL_DEFAULT_PER_WORKER_TOKENS = 65_536;
export const GOAL_DEFAULT_MAX_DESCENDANTS = 60;
export const GOAL_MAX_DEPTH = 1;
export const GOAL_MAX_HOPS = 6;
export const GOAL_DEFAULT_DURATION_MS = 8 * 60 * 60 * 1000;

export const GoalStatusSchema = z.enum([
  "running",
  "needs-owner",
  "paused",
  "blocked",
  "stopped",
  "exhausted",
  "completed",
  "accepted",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/** Read-only projection of the admission ledger, never a provider cost estimate. */
export function goalBudget(
  limit: number,
  root: { usedTokens: number; reservedTokens: number; tokenLimit: number } | null,
  usageComplete: boolean,
) {
  return {
    usedTokens: root?.usedTokens ?? null,
    reservedTokens: root?.reservedTokens ?? null,
    availableTokens: root
      ? Math.max(0, Math.min(limit, root.tokenLimit) - root.usedTokens - root.reservedTokens)
      : null,
    usageComplete: root !== null && usageComplete,
  };
}

/** Stable data key; each frontend translates it when displaying the default condition. */
export const GOAL_FINAL_REVIEW_DESCRIPTION = "goal.final-owner-review";

export const GoalConditionStatusSchema = z.enum(["unknown", "pass", "fail"]);
export type GoalConditionStatus = z.infer<typeof GoalConditionStatusSchema>;

export const GoalConditionSchema = z.object({
  id: Id,
  description: z.string(),
  status: GoalConditionStatusSchema,
  actorId: Id.nullable(),
  reason: z.string().nullable(),
  evidenceId: Id.nullable(),
  createdAt: IsoDate.nullable(),
});
export type GoalCondition = z.infer<typeof GoalConditionSchema>;

export const GoalRevisionSchema = z.object({
  id: Id,
  goalId: Id,
  summary: z.string(),
  conditions: z.array(GoalConditionSchema),
  artifacts: z.array(z.object({ id: Id, hash: z.string() })),
  reports: z.array(z.object({ id: Id, revision: z.string() })),
  attempts: z.number().int(),
  accountingSnapshot: z.object({
    usedTokens: z.number().int(),
    reservedTokens: z.number().int(),
  }),
  createdAt: IsoDate,
});
export type GoalRevision = z.infer<typeof GoalRevisionSchema>;

export const GoalVerdictTypeSchema = z.enum(["accept", "reject"]);

export const GoalVerdictSchema = z.object({
  id: Id,
  goalId: Id,
  revisionId: Id,
  actorId: Id,
  type: GoalVerdictTypeSchema,
  reworkNotes: z.string().nullable(),
  createdAt: IsoDate,
});
export type GoalVerdict = z.infer<typeof GoalVerdictSchema>;

export const GoalSubmitInputSchema = z.object({
  goalId: Id,
  summary: z.string().trim().min(1).max(10_000),
  artifacts: z.array(z.object({ id: Id, hash: z.string() })).default([]),
  reports: z.array(z.object({ id: Id, revision: z.string() })).default([]),
});
export type GoalSubmitInput = z.infer<typeof GoalSubmitInputSchema>;

export const GoalAcceptInputSchema = z.object({
  goalId: Id,
  revisionId: Id,
});
export type GoalAcceptInput = z.infer<typeof GoalAcceptInputSchema>;

export const GoalRejectInputSchema = z.object({
  goalId: Id,
  revisionId: Id,
  reworkNotes: z.string().trim().min(1).max(4_000),
});
export type GoalRejectInput = z.infer<typeof GoalRejectInputSchema>;

export const GoalSchema = z.object({
  id: Id,
  spaceId: Id,
  groupId: Id,
  threadId: Id,
  coordinatorBotId: Id,
  rootTaskId: Id,
  objective: z.string(),
  doneWhen: z.array(z.string()),
  status: GoalStatusSchema,
  tokenLimit: z.number().int(),
  usedTokens: z.number().int().nonnegative().nullable(),
  reservedTokens: z.number().int().nonnegative().nullable(),
  availableTokens: z.number().int().nonnegative().nullable(),
  usageComplete: z.boolean(),
  perWorkerTokens: z.number().int(),
  maxConcurrent: z.number().int(),
  maxDescendants: z.number().int(),
  maxDepth: z.literal(GOAL_MAX_DEPTH),
  maxHops: z.literal(GOAL_MAX_HOPS),
  currentRevision: GoalRevisionSchema.nullable().optional(),
  untilAt: IsoDate,
  createdAt: IsoDate,
  stoppedAt: IsoDate.nullable(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const GoalStartInputSchema = z.object({
  groupId: Id,
  objective: z.string().trim().min(1).max(4_000),
  doneWhen: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  untilAt: IsoDate.optional(),
  tokenLimit: z.number().int().min(1).max(5_000_000).optional(),
  perWorkerTokens: z.number().int().min(5_000).max(GOAL_MAX_PER_WORKER_TOKENS).optional(),
  maxConcurrent: z.number().int().min(1).max(12).optional(),
  maxDescendants: z.number().int().min(1).max(200).optional(),
});
export type GoalStartInput = z.infer<typeof GoalStartInputSchema>;

export const goalsContract = {
  start: oc.input(GoalStartInputSchema).output(GoalSchema),
  get: oc.input(z.object({ groupId: Id })).output(GoalSchema.nullable()),
  stop: oc.input(z.object({ goalId: Id })).output(GoalSchema),

  submit: oc.input(GoalSubmitInputSchema).output(GoalRevisionSchema),
  accept: oc.input(GoalAcceptInputSchema).output(GoalVerdictSchema),
  reject: oc.input(GoalRejectInputSchema).output(GoalVerdictSchema),
};
