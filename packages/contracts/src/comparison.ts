import { oc } from "@orpc/contract";
import * as z from "zod";
import { DelegationSnapshotSchema, TaskCardRequestSchema } from "./delegation.js";
import { MessageBlock } from "./events.js";

export const ComparisonSnapshotSchema = z.object({
  text: z.string().min(1).max(20000),
  artifactIds: z.array(z.string()).max(20),
  environmentNote: z.string(),
  capturedAt: z.iso.datetime(),
  card: TaskCardRequestSchema,
  documents: z
    .array(z.object({ documentId: z.string(), revision: z.number().int(), content: z.string() }))
    .default([]),
  artifacts: z.array(
    z.object({ id: z.string(), name: z.string(), mimeType: z.string(), hash: z.string() }),
  ),
});
export type ComparisonSnapshot = z.infer<typeof ComparisonSnapshotSchema>;
export const ComparisonParticipantSchema = z.object({
  botId: z.string(),
  name: z.string(),
  executing: DelegationSnapshotSchema,
});
export type ComparisonParticipant = z.infer<typeof ComparisonParticipantSchema>;
export const ComparisonResultSchema = z.object({
  botId: z.string(),
  runId: z.string(),
  delegationId: z.string(),
  status: z.enum([
    "queued",
    "running",
    "waiting-approval",
    "completed",
    "failed",
    "cancelled",
    "incomplete",
  ]),
  outputMessageIds: z.array(z.string()),
  outputArtifactIds: z.array(z.string()),
  output: z.string(),
  citations: z.array(z.string()),
  usage: z.object({
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    reported: z.boolean(),
    costs: z.array(z.object({ amount: z.number(), provenance: z.string() })),
  }),
  durationMs: z.number().nonnegative().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  failure: z.string().nullable(),
  provenance: z.object({
    reportedModel: z.string().nullable(),
    reportedModelVersion: z.string().nullable(),
    effortAttested: z.boolean().optional(),
    effortAttestationReason: z.string().nullable().optional(),
    memoryRead: z.boolean(),
    memoryDiffered: z.boolean(),
    ambientHistory: z.literal(false),
    toolsRestricted: z.literal(true),
  }),
  approvals: z.array(
    z.object({
      messageId: z.string(),
      block: MessageBlock.refine((block) => block.kind === "ask"),
    }),
  ),
});
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
export const ComparisonSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  requesterUserId: z.string(),
  coordinatorBotId: z.string(),
  rootTaskId: z.string(),
  snapshot: ComparisonSnapshotSchema,
  participants: z.array(ComparisonParticipantSchema).min(2).max(4),
  budget: z.object({
    tokens: z.number().int(),
    perRunTokens: z.number().int(),
    mergeReserved: z.boolean(),
    deadlineAt: z.iso.datetime(),
  }),
  status: z.enum(["running", "completed", "incomplete"]),
  results: z.array(ComparisonResultSchema),
  merge: z
    .object({
      participant: ComparisonParticipantSchema,
      selectedRunIds: z.array(z.string()),
      result: ComparisonResultSchema,
    })
    .nullable(),
  createdAt: z.iso.datetime(),
});
export type Comparison = z.infer<typeof ComparisonSchema>;
export const ComparisonStartSchema = z
  .object({
    coordinatorBotId: z.string(),
    participantBotIds: z.array(z.string()).min(2).max(4),
    text: z.string().trim().min(1).max(20000).optional(),
    artifactIds: z.array(z.string()).max(20).default([]),
    delegationId: z.string().optional(),
    reserveMerge: z.boolean().default(true),
    expectedParticipants: z.array(ComparisonParticipantSchema).min(2).max(4).optional(),
    clientNonce: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.participantBotIds).size === value.participantBotIds.length &&
      value.participantBotIds.includes(value.coordinatorBotId),
    "Include the current bot and choose two to four different bots.",
  )
  .refine(
    (value) => Boolean(value.text) !== Boolean(value.delegationId),
    "Choose a task or enter a message.",
  );
export type ComparisonStart = z.infer<typeof ComparisonStartSchema>;
export const ComparisonMergeSchema = z
  .object({
    id: z.string(),
    selectedRunIds: z.array(z.string()).min(1).max(4),
    botId: z.string(),
    reserveBudget: z.boolean().default(false),
    expectedParticipant: ComparisonParticipantSchema.optional(),
  })
  .strict()
  .refine((value) => new Set(value.selectedRunIds).size === value.selectedRunIds.length);
export type ComparisonMerge = z.infer<typeof ComparisonMergeSchema>;
export const ComparisonExportSchema = z.object({
  format: z.literal("ardurbot.comparison"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  comparison: ComparisonSchema,
});
export const comparisonsContract = {
  previewMerge: oc
    .input(z.object({ id: z.string(), botId: z.string() }))
    .output(ComparisonParticipantSchema),
  preview: oc.input(ComparisonStartSchema).output(
    z.object({
      participants: z.array(ComparisonParticipantSchema),
      tokens: z.number().int(),
      runs: z.number().int(),
    }),
  ),
  create: oc.input(ComparisonStartSchema).output(ComparisonSchema),
  list: oc.input(z.object({})).output(z.array(ComparisonSchema)),
  get: oc.input(z.object({ id: z.string() })).output(ComparisonSchema),
  merge: oc.input(ComparisonMergeSchema).output(ComparisonSchema),
};
