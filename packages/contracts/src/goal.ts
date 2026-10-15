import { oc } from "@orpc/contract";
import * as z from "zod";
import { BoardItemIdSchema } from "./board-id.js";
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

/**
 * A goal in these statuses refuses new admission: it is awaiting owner review or already
 * accepted, so queued resumes, peer work and effect dispatch must not run for its runs.
 */
export const GOAL_FROZEN_STATUSES = ["completed", "accepted"] as const;

export function isFrozenGoalStatus(status: string): boolean {
  return (GOAL_FROZEN_STATUSES as readonly string[]).includes(status);
}

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

/**
 * Stable data key written on delegation cards and results when the owner-review freeze
 * cancels work; each frontend translates it when displaying, never renders it raw.
 */
export const GOAL_FREEZE_CANCELLED = "goal.freeze-cancelled";

/** Translate only standalone stored reason lines; preserve surrounding worker text. */
export function goalDisplayText(text: string, freezeCancelled: string): string {
  return text
    .split("\n")
    .map((line) => (line === GOAL_FREEZE_CANCELLED ? freezeCancelled : line))
    .join("\n");
}
/** Board comments. The result path is a same-app route, never a supplied URL. */
export const GOAL_BOARD_COMPLETED = "Goal completed";
export const GOAL_BOARD_ACCEPTED = "Goal accepted";

export const GoalBoardDeliveryStateSchema = z.enum([
  "pending",
  "delivered",
  "paused",
  "needs-owner",
]);
export type GoalBoardDeliveryState = z.infer<typeof GoalBoardDeliveryStateSchema>;
export const GoalBoardTransitionSchema = z.enum(["completed", "accepted"]);
export type GoalBoardTransition = z.infer<typeof GoalBoardTransitionSchema>;

/**
 * The owner reviewed a paused board delivery: "retry" re-queues it, "handle"
 * closes it without delivering. Both are once-only for the pause they were
 * reviewed against: `attempt` is the row's attempt count at review time, so an
 * action formed against an earlier pause is refused after the worker re-pauses.
 */
export const GoalBoardDeliveryActionSchema = z.enum(["retry", "handle"]);
export type GoalBoardDeliveryAction = z.infer<typeof GoalBoardDeliveryActionSchema>;

export const GoalBoardDeliveryActionInputSchema = z.object({
  goalId: Id,
  deliveryId: Id,
  action: GoalBoardDeliveryActionSchema,
  /** The row's attempt count shown with the action; binds the action to that pause. */
  attempt: z.number().int().nonnegative(),
});
export type GoalBoardDeliveryActionInput = z.infer<typeof GoalBoardDeliveryActionInputSchema>;

export function goalResultPath(groupId: string, goalId: string, revisionId: string) {
  return `/app/g/${encodeURIComponent(groupId)}?goal=${encodeURIComponent(goalId)}&revision=${encodeURIComponent(revisionId)}`;
}

export function boardItemPath(workspaceId: string, itemId: string) {
  return `/app/board?workspace=${encodeURIComponent(workspaceId)}&item=${encodeURIComponent(itemId)}`;
}

export function goalBoardDeliveryKey(
  goalId: string,
  revisionId: string,
  transition: GoalBoardTransition,
) {
  return `${goalId}:${revisionId}:${transition}`;
}

export const GoalConditionStatusSchema = z.enum(["unknown", "pass", "fail"]);
export type GoalConditionStatus = z.infer<typeof GoalConditionStatusSchema>;

export const GoalConditionSupportKindSchema = z.enum(["artifact", "tool-result", "run"]);
export type GoalConditionSupportKind = z.infer<typeof GoalConditionSupportKindSchema>;

/**
 * A record tied to a condition's review: an artifact revision, a tool-result
 * record, or a run record. Support links attest that a decision was recorded
 * against an immutable record; they are not a claim that the execution itself
 * succeeded — run outcomes stay on the run.
 */
const SupportHashSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);

export const GoalConditionSupportSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifact"), recordId: Id, revision: SupportHashSchema }),
  z.strictObject({ kind: z.literal("tool-result"), recordId: Id, revision: SupportHashSchema }),
  z.strictObject({ kind: z.literal("run"), recordId: Id, revision: z.null() }),
]);
export type GoalConditionSupport = z.infer<typeof GoalConditionSupportSchema>;

export const GoalConditionSchema = z.object({
  id: Id,
  description: z.string(),
  status: GoalConditionStatusSchema,
  actorId: Id.nullable(),
  reason: z.string().nullable(),
  evidenceId: Id.nullable(),
  /** Records the owner's review attested for this decision. */
  support: z.array(GoalConditionSupportSchema).default([]),
  /** Records a bot proposed; a proposal is never a pass/fail decision. */
  proposedSupport: z.array(GoalConditionSupportSchema).default([]),
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

/**
 * Durable marker written when the owner accepts a revision. Usage that settles after
 * this marker is counted as lateTokens and remains a visible discrepancy; the accepted
 * result itself never changes.
 */
export const GoalSettlementSchema = z.object({
  revisionId: Id,
  usedTokens: z.number().int(),
  reservedTokens: z.number().int(),
  lateTokens: z.number().int(),
  discrepancyCount: z.number().int().nonnegative(),
  createdAt: IsoDate,
});
export type GoalSettlement = z.infer<typeof GoalSettlementSchema>;

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

/**
 * Owner marks one condition on the revision under review and may attest the
 * records that support the decision. Workers cannot call this.
 */
export const GoalConditionReviewInputSchema = z.object({
  goalId: Id,
  revisionId: Id,
  conditionId: z.string().trim().min(1).max(200),
  status: z.enum(["pass", "fail"]),
  reason: z.string().trim().max(2_000).optional(),
  support: z.array(GoalConditionSupportSchema).max(20).optional(),
});
export type GoalConditionReviewInput = z.infer<typeof GoalConditionReviewInputSchema>;

/**
 * The coordinator bot proposes records that support a condition. Proposals are
 * stored as proposedSupport; only the owner's review records pass or fail.
 */
export const GoalSupportProposalInputSchema = z.object({
  goalId: Id,
  spaceId: Id,
  userId: Id,
  coordinatorBotId: Id,
  threadId: Id,
  revisionId: Id,
  conditionId: z.string().trim().min(1).max(200),
  support: z.array(GoalConditionSupportSchema).max(20),
});
export type GoalSupportProposalInput = z.infer<typeof GoalSupportProposalInputSchema>;

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
  settlement: GoalSettlementSchema.nullable().optional(),
  untilAt: IsoDate,
  createdAt: IsoDate,
  stoppedAt: IsoDate.nullable(),
  boardWorkspaceId: Id.nullable().optional(),
  boardItemId: BoardItemIdSchema.nullable().optional(),
  boardDelivery: GoalBoardDeliveryStateSchema.nullable().optional(),
  /** Delivery rows paused or needing the owner, with the action each one allows. */
  boardDeliveryActions: z
    .array(
      z.object({
        id: Id,
        transition: GoalBoardTransitionSchema,
        state: z.enum(["paused", "needs-owner"]),
        /** Attempt count for the current pause; send it back with the recovery action. */
        attempt: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const GoalStartInputSchema = z
  .object({
    groupId: Id,
    objective: z.string().trim().min(1).max(4_000),
    doneWhen: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
    untilAt: IsoDate.optional(),
    tokenLimit: z.number().int().min(1).max(5_000_000).optional(),
    perWorkerTokens: z.number().int().min(5_000).max(GOAL_MAX_PER_WORKER_TOKENS).optional(),
    maxConcurrent: z.number().int().min(1).max(12).optional(),
    maxDescendants: z.number().int().min(1).max(200).optional(),
    boardWorkspaceId: Id.optional(),
    boardItemId: BoardItemIdSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.boardWorkspaceId === undefined) !== (input.boardItemId === undefined))
      ctx.addIssue({
        code: "custom",
        path: ["boardItemId"],
        message: "Board link needs a workspace and an item",
      });
  });
export type GoalStartInput = z.infer<typeof GoalStartInputSchema>;

export const GoalLinkInputSchema = z
  .object({
    goalId: Id,
    boardWorkspaceId: Id.nullable(),
    boardItemId: BoardItemIdSchema.nullable(),
  })
  .superRefine((input, ctx) => {
    if ((input.boardWorkspaceId === null) !== (input.boardItemId === null))
      ctx.addIssue({
        code: "custom",
        path: ["boardItemId"],
        message: "Board link needs a workspace and an item",
      });
  });
export type GoalLinkInput = z.infer<typeof GoalLinkInputSchema>;

export const GoalBoardResultSchema = z.object({
  goalId: Id,
  groupId: Id,
  revisionId: Id.nullable(),
  summary: z.string().nullable(),
  status: GoalStatusSchema,
  delivery: GoalBoardDeliveryStateSchema.nullable(),
  path: z.string(),
});
export type GoalBoardResult = z.infer<typeof GoalBoardResultSchema>;

export const GoalRevisionViewSchema = z.object({
  goal: GoalSchema,
  current: z.boolean(),
});
export type GoalRevisionView = z.infer<typeof GoalRevisionViewSchema>;

/** Named so the app contract can reference it without exceeding inference limits. */
export type GoalsContract = typeof goalsContract;

export const goalsContract = {
  start: oc.input(GoalStartInputSchema).output(GoalSchema),
  get: oc.input(z.object({ groupId: Id })).output(GoalSchema.nullable()),
  revision: oc
    .input(z.object({ groupId: Id, goalId: Id, revisionId: Id }))
    .output(GoalRevisionViewSchema.nullable()),
  stop: oc.input(z.object({ goalId: Id })).output(GoalSchema),

  submit: oc.input(GoalSubmitInputSchema).output(GoalRevisionSchema),
  accept: oc.input(GoalAcceptInputSchema).output(GoalVerdictSchema),
  reject: oc.input(GoalRejectInputSchema).output(GoalVerdictSchema),
  reviewCondition: oc.input(GoalConditionReviewInputSchema).output(GoalRevisionSchema),
  link: oc.input(GoalLinkInputSchema).output(GoalSchema),
  boardDelivery: oc.input(GoalBoardDeliveryActionInputSchema).output(GoalSchema),
  boardResult: oc
    .input(z.object({ workspaceId: Id, itemId: BoardItemIdSchema }))
    .output(GoalBoardResultSchema.nullable()),
};
