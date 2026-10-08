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
};
