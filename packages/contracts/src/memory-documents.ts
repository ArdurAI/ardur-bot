import { z } from "zod";
import { ImportedProvenanceSchema } from "./local-import.js";
import { RuntimePinSchema } from "./runtime-pins.js";

export const MemoryIdentity = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const DocumentScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("group"),
      spaceId: MemoryIdentity,
      userId: MemoryIdentity,
      botId: MemoryIdentity,
      groupId: MemoryIdentity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bot"),
      spaceId: MemoryIdentity,
      userId: MemoryIdentity,
      botId: MemoryIdentity,
    })
    .strict(),
  z.object({ kind: z.literal("user"), spaceId: MemoryIdentity, userId: MemoryIdentity }).strict(),
  z.object({ kind: z.literal("space-shared"), spaceId: MemoryIdentity }).strict(),
]);
export const RevisionAuthorSchema = z
  .object({
    kind: z.enum(["user", "bot", "runtime", "learning-loop"]),
    userId: MemoryIdentity.optional(),
    botId: MemoryIdentity.optional(),
  })
  .strict();
export const MemoryModelSchema = z
  .object({
    provider: z.string().min(1).max(160),
    modelId: z.string().min(1).max(300),
    effort: z.string().max(80).nullable(),
  })
  .strict();
export const LearningProvenanceSchema = z
  .object({
    proposalId: z.string(),
    approvingUserId: MemoryIdentity,
    grantId: z.string().optional(),
    originatingPin: RuntimePinSchema.nullable(),
    reviewerPin: RuntimePinSchema,
    policyVersion: z.string(),
    action: z.enum(["apply", "revert"]),
    parentRevision: z.number().int().nonnegative(),
  })
  .strict();
export type LearningProvenance = z.infer<typeof LearningProvenanceSchema>;
export const MemoryDocumentKindSchema = z.enum(["profile", "preferences", "topic"]);
export const DocumentRevisionSchema = z
  .object({
    kind: MemoryDocumentKindSchema.optional(),
    documentId: MemoryIdentity,
    revision: z.number().int().positive(),
    scopeKey: DocumentScopeSchema,
    path: z.string().min(1).max(500),
    content: z.string().max(1_000_000),
    author: RevisionAuthorSchema,
    learning: LearningProvenanceSchema.optional(),
    imported: ImportedProvenanceSchema.optional(),
    model: MemoryModelSchema.nullable(),
    runId: MemoryIdentity.nullable(),
    threadId: MemoryIdentity.nullable(),
    references: z.array(z.string().max(2000)).max(100),
    createdAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
    commitId: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
  })
  .strict();
export const DocumentDeliverySchema = z
  .object({
    status: z.enum(["pending", "delivered", "failed"]),
    generation: z.number().int().nonnegative(),
    provider: z.string().nullable(),
    receipt: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,200}$/)
      .optional(),
    retryAt: z.string().datetime().optional(),
  })
  .strict();
export const GitRevisionSyncSchema = z.object({
  status: z.enum(["pending", "pushed", "failed"]),
  branch: z.string(),
});
export const MemorySyncStateSchema = z.object({
  host: z.string(),
  status: z.enum(["ready", "pending", "failed", "last-copy", "quarantined"]),
  branch: z.string(),
  proposalBranch: z.string().nullable(),
});
export const MemoryHistoryRevisionSchema = DocumentRevisionSchema.extend({
  gitSync: GitRevisionSyncSchema.optional(),
});
export const MemoryDocumentHeadSchema = MemoryHistoryRevisionSchema.extend({
  id: MemoryIdentity,
  updatedAt: z.string().datetime(),
  delivery: DocumentDeliverySchema,
});
export const MemoryBundleSchema = z
  .object({
    version: z.literal(1),
    documents: z
      .array(
        z
          .object({
            id: MemoryIdentity,
            revisions: z.array(DocumentRevisionSchema).min(1).max(10000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export const MemoryPageInput = z.object({
  cursor: MemoryIdentity.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  botId: MemoryIdentity.optional(),
  scope: z.enum(["bot", "user", "space-shared", "group"]).optional(),
  includeDeleted: z.boolean().default(false),
});
export const MemoryDocumentPageSchema = z.object({
  items: z.array(MemoryDocumentHeadSchema),
  nextCursor: z.string().nullable(),
});
export const MemoryHistoryPageSchema = z.object({
  items: z.array(MemoryHistoryRevisionSchema),
  nextCursor: z.number().nullable(),
});
export const MemoryScopeRemapSchema = z.record(z.string(), DocumentScopeSchema);
export const MemoryImportPreviewSchema = z.object({
  hash: z.string(),
  documents: z.number(),
  revisions: z.number(),
  conflicts: z.array(z.object({ id: z.string(), path: z.string() })),
  scopes: z.array(z.object({ from: z.string(), to: DocumentScopeSchema })),
});
export type DocumentScope = z.infer<typeof DocumentScopeSchema>;
export type RevisionAuthor = z.infer<typeof RevisionAuthorSchema>;
export type MemoryModel = z.infer<typeof MemoryModelSchema>;
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>;
export type MemoryHistoryRevision = z.infer<typeof MemoryHistoryRevisionSchema>;
export type MemorySyncState = z.infer<typeof MemorySyncStateSchema>;
export type DocumentDelivery = z.infer<typeof DocumentDeliverySchema>;
export type MemoryDocumentHead = z.infer<typeof MemoryDocumentHeadSchema>;
export type MemoryBundle = z.infer<typeof MemoryBundleSchema>;
export type MemoryPage = z.infer<typeof MemoryDocumentPageSchema>;
export type MemoryImportPreview = z.infer<typeof MemoryImportPreviewSchema>;
