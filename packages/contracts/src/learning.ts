import { z } from "zod";
import { RuntimePinSchema } from "./runtime-pins.js";

export const MessageOriginSchema = z.enum([
  "human-typed",
  "follow-up",
  "webhook",
  "messaging",
  "peer-bot",
  "system",
]);
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;
export const LearningScopeSchema = z
  .object({
    spaceId: z.string(),
    botId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();
export const LearningProposalTypeSchema = z.enum([
  "memory",
  "skill",
  "preference",
  "policy-suggestion",
  "pin-insight",
  "harness-issue",
]);
export const LearningCandidateSchema = z
  .object({
    type: LearningProposalTypeSchema,
    scope: LearningScopeSchema,
    target: z
      .object({ documentId: z.string().optional(), settingKey: z.string().max(160).optional() })
      .strict(),
    expectedBaseRevision: z.number().int().nonnegative().optional(),
    proposedContent: z.string().max(12000).optional(),
    typedDelta: z
      .object({
        key: z.string().max(160),
        value: z.union([z.string().max(2000), z.boolean(), z.number().finite()]),
      })
      .strict()
      .optional(),
    rationale: z.string().min(1).max(2000),
    evidenceIds: z.array(z.string()).min(1).max(30),
    confidence: z
      .object({ label: z.literal("model estimate"), value: z.number().min(0).max(1) })
      .strict(),
  })
  .strict()
  .refine(
    (value) => (value.proposedContent !== undefined) !== (value.typedDelta !== undefined),
    "Provide content or a typed delta.",
  );
export const ObservationWindowSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});
const CorrectionsSchema = z.object({
  feedback: z.number().int().nonnegative(),
  steering: z.number().int().nonnegative(),
});
const DeltaSchema = z.object({
  beforeSamples: z.number().int(),
  afterSamples: z.number().int(),
  beforeMean: z.number().nullable(),
  afterMean: z.number().nullable(),
  delta: z.number().nullable(),
});
export const LearningObservationSchema = z.object({
  documentId: z.string(),
  revisionId: z.string(),
  exposedRuns: z.number().int().nonnegative(),
  correctionsAfter: CorrectionsSchema,
  before: z.object({
    runs: z.number().int(),
    comparableExposedRuns: z.number().int(),
    corrections: CorrectionsSchema,
    window: ObservationWindowSchema,
  }),
  denialsAfter: z.object({
    inappropriate: z.number().int(),
    safety: z.number().int(),
    unknown: z.number().int(),
  }),
  failuresAfter: z.object({
    task: z.number().int(),
    integration: z.number().int(),
    provider: z.number().int(),
    pin: z.number().int(),
    unknown: z.number().int(),
  }),
  cancellationsAfter: z.number().int(),
  timeTokensDelta: z.object({ timeMs: DeltaSchema, tokens: DeltaSchema }),
  acceptance: z.object({
    accepted: z.number().int(),
    evaluated: z.number().int(),
    contracts: z.number().int(),
  }),
  window: ObservationWindowSchema,
  missing: z.array(z.string()),
});
export type LearningObservation = z.infer<typeof LearningObservationSchema>;
export function learningObservationSummary(value: LearningObservation): string {
  const after = value.correctionsAfter.feedback + value.correctionsAfter.steering;
  const before = value.before.corrections.feedback + value.before.corrections.steering;
  return `${after} corrections in ${value.exposedRuns} exposed runs; before: ${before} in ${value.before.runs} comparable runs`;
}
export function learningObservationUnmeasured(value: LearningObservation): boolean {
  return value.exposedRuns < 5 || value.before.runs < 5;
}
export const LearningJourneyEntrySchema = z.object({
  id: z.string(),
  at: z.string().datetime(),
  action: z.string(),
  botId: z.string().optional(),
  proposalId: z.string().optional(),
  revisionId: z.string().optional(),
  documentId: z.string().optional(),
  grantId: z.string().optional(),
});
export type LearningJourneyEntry = z.infer<typeof LearningJourneyEntrySchema>;
export const CuratorReportSchema = z.object({
  id: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  status: z.enum(["running", "completed", "failed"]),
  checked: z.number().int(),
  staleIds: z.array(z.string()),
  flaggedIds: z.array(z.string()),
  proposalIds: z.array(z.string()),
  durationMs: z.number().int(),
  tokens: z.number().int().nullable(),
});
export type CuratorReport = z.infer<typeof CuratorReportSchema>;
export const LearningProposalSchema = z
  .object({
    ...LearningCandidateSchema.shape,
    confidence: LearningCandidateSchema.shape.confidence.optional(),
    operation: z.enum(["revert-suggestion", "consolidation"]).optional(),
    revertsProposalId: z.string().optional(),
    participatingRevisions: z
      .array(z.object({ documentId: z.string(), revision: z.number().int().positive() }))
      .max(10)
      .optional(),
    policyTool: z.string().min(1).max(160).optional(),
    policyRuleId: z.string().optional(),
    observation: LearningObservationSchema.optional(),
    id: z.string(),
    diff: z.string().max(40000),
    status: z.enum([
      "pending",
      "approved",
      "rejected",
      "applied",
      "expired",
      "superseded",
      "reverted",
    ]),
    expiresAt: z.string().datetime(),
    appliedRevisionId: z.string().optional(),
    revertedRevisionId: z.string().optional(),
    appliedAt: z.string().datetime().optional(),
    documentId: z.string().optional(),
    blockedReason: z.string().optional(),
    settingBefore: z.boolean().optional(),
    provenance: z
      .object({
        runId: z.string(),
        originatingPin: RuntimePinSchema.nullable(),
        reviewerPin: RuntimePinSchema,
        policyVersion: z.string(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.proposedContent !== undefined) !== (value.typedDelta !== undefined),
    "Provide content or a typed delta.",
  );
export type LearningProposal = z.infer<typeof LearningProposalSchema>;
export type LearningCandidate = z.infer<typeof LearningCandidateSchema>;
export const ObservedOutcomeSchema = z
  .object({
    category: z.enum([
      "failure",
      "denial",
      "cancellation",
      "tool-error",
      "acceptance",
      "timing",
      "tokens",
      "feedback",
    ]),
    classification: z.enum([
      "runtime",
      "pin",
      "provider",
      "execution",
      "human",
      "policy",
      "cancelled",
      "completed",
      "positive",
      "negative",
      "unknown",
    ]),
    value: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const ProposalEvidenceSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["instruction-span", "observed-outcome"]),
    sourceClass: z.enum([
      "human-message",
      "human-steering",
      "feedback-reason",
      "run",
      "tool",
      "approval",
      "usage",
      "feedback",
    ]),
    actorId: z.string().optional(),
    runId: z.string(),
    threadId: z.string().optional(),
    eventIds: z.array(z.string()).max(30),
    redactionVersion: z.literal(1),
    excerpt: z.string().max(1000).optional(),
    outcome: ObservedOutcomeSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.kind === "instruction-span"
        ? !!value.actorId && !!value.excerpt && !value.outcome
        : value.excerpt === undefined && !!value.outcome,
    "Evidence channels must stay separate.",
  );
export type ProposalEvidence = z.infer<typeof ProposalEvidenceSchema>;
export const ReviewExecutionSchema = z.object({
  idempotencyKey: z.string(),
  runId: z.string(),
  historyGeneration: z.number().int(),
  evidenceWatermark: z.string(),
  policyVersion: z.string(),
  status: z.enum(["skipped", "no-change", "proposed", "paused", "failed"]),
  reason: z.string().nullable().optional(),
  tokens: z.number().int().nullable().optional(),
  reviewerPin: RuntimePinSchema,
  proposalIds: z.array(z.string()),
});
export type ReviewExecution = z.infer<typeof ReviewExecutionSchema>;
export const LearningBudgetsSchema = z.object({
  botDailyTokens: z.number().int().min(0).max(10000000).default(30000),
  spaceDailyTokens: z.number().int().min(0).max(100000000).default(150000),
  maxProposals: z.number().int().min(1).max(10).default(3),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxOutputTokens: z.number().int().min(128).max(8000).default(2000),
  maxOutputChars: z.number().int().min(256).max(40000).default(12000),
});
export const SpaceLearningConfigInput = z
  .object({
    enabled: z.boolean().default(false),
    consolidationEnabled: z.boolean().default(false),
    reviewerPin: RuntimePinSchema.nullable().default(null),
    budgets: LearningBudgetsSchema.default(() => LearningBudgetsSchema.parse({})),
  })
  .strict();
export const SpaceLearningConfigSchema = SpaceLearningConfigInput.extend({
  destination: RuntimePinSchema.nullable(),
  canConfigure: z.boolean().default(false),
});
export type SpaceLearningConfig = z.infer<typeof SpaceLearningConfigSchema>;
export const RunKnowledgeExposureSchema = z.object({
  runId: z.string(),
  attempt: z.number().int(),
  documentId: z.string(),
  revisionId: z.string(),
  contentHash: z.string(),
  kind: z.enum(["injected", "invoked", "read"]),
  truncated: z.boolean(),
});
export type RunKnowledgeExposure = z.infer<typeof RunKnowledgeExposureSchema>;

export const LearningGrantScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), botId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("user") }).strict(),
]);
export const LearningGrantInputSchema = z
  .object({
    category: z.enum(["memory", "skill"]),
    scope: LearningGrantScopeSchema,
    expiresAt: z.string().datetime().optional(),
    limits: z
      .object({ maxPerDay: z.number().int().min(1).max(20).default(5) })
      .default({ maxPerDay: 5 }),
  })
  .strict();
export const LearningGrantSchema = LearningGrantInputSchema.extend({
  id: z.string(),
  spaceId: z.string(),
  userId: z.string(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
});
export type LearningGrant = z.infer<typeof LearningGrantSchema>;
export type LearningGrantInput = z.infer<typeof LearningGrantInputSchema>;
export const LearningEditSchema = z
  .object({
    proposedContent: z.string().min(1).max(12000).optional(),
    typedDelta: z
      .object({ key: z.string().max(160), value: z.boolean() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.proposedContent !== undefined) !== (value.typedDelta !== undefined));
export type LearningEdit = z.infer<typeof LearningEditSchema>;
export const LearningActionSchema = z.object({
  proposal: LearningProposalSchema,
  conflict: z
    .object({
      before: z.string(),
      applied: z.string(),
      current: z.string(),
      expectedRevision: z.number(),
    })
    .optional(),
});
export const LearningCountsSchema = z.object({
  pendingCount: z.number(),
  appliedThisWeek: z.number(),
});
export const LearningInboxSchema = z.object({
  reviews: z.array(ReviewExecutionSchema),
  proposals: z.array(LearningProposalSchema),
  botNames: z.record(z.string(), z.string()).default({}),
  pendingCount: z.number(),
  appliedThisWeek: z.number(),
});
export function learningApprovalBlock(proposal: LearningProposal): string | undefined {
  if (!proposal.scope.userId) return "Shared skills need a reviewer — coming later";
  if (["pin-insight", "harness-issue"].includes(proposal.type))
    return "This suggestion cannot be approved here yet.";
  if (
    proposal.type === "preference" &&
    (!proposal.scope.botId ||
      !["bot.notifyOnFinish", "bot.autoSpeak"].includes(proposal.typedDelta?.key ?? "") ||
      typeof proposal.typedDelta?.value !== "boolean")
  )
    return "This preference needs a visible setting before it can be applied.";
  if (proposal.type === "policy-suggestion" && (!proposal.policyTool || !proposal.scope.botId))
    return "This suggestion cannot be approved here yet.";
  return proposal.blockedReason;
}

export function learningJourneyLabel(action: string): string {
  const labels: Record<string, string> = {
    applied: "Applied",
    approve: "Applied",
    "auto-apply": "Applied with a grant",
    revert: "Undone",
    "approve-revert": "Undo approved",
    "approve-policy": "Policy approved",
    "grant-created": "Automatic learning turned on",
    "grant-revoked": "Automatic learning turned off",
    "curator-stale": "Marked stale",
    "curator-regression": "Possible regression",
    "curator-consolidation": "Proposed consolidation",
    "curator-policy": "Proposed policy",
  };
  return labels[action] ?? "Learning change";
}
