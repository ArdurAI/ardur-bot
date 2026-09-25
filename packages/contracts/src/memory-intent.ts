import { z } from "zod";
import { MemoryDocumentKindSchema } from "./memory-documents.js";

export const MEMORY_INTENT_POLICY = "memory-settings-v1";
export const MEMORY_REVIEW_UNAVAILABLE_MESSAGE =
  "Memory review is not available with Claude Code or Codex yet; import memory or edit a document directly.";

export const MemoryIntentInputSchema = z
  .object({
    intent: z.enum(["import", "edit"]),
    text: z.string().trim().min(1).max(12000),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict()
  .refine(
    (input) => input.intent === "import" || input.text.length <= 4000,
    "Memory instructions are limited to 4000 characters.",
  );
export type MemoryIntentInput = z.infer<typeof MemoryIntentInputSchema>;
export const MemoryDraftSchema = z
  .object({
    action: z.enum(["save", "delete"]),
    documentId: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().default(0),
    kind: MemoryDocumentKindSchema.default("topic"),
    content: z.string().max(12000),
  })
  .strict();
export type MemoryDraft = z.infer<typeof MemoryDraftSchema>;
export const MemoryDraftsSchema = z
  .object({ proposals: z.array(MemoryDraftSchema).max(3) })
  .strict();
export const MEMORY_IMPORT_PROMPT =
  "Summarize what you remember about me as plain bullet points. Group them under Profile, Preferences, and Topics. Include only information I shared or explicitly asked you to remember. Leave out passwords, API keys, private account details, and guesses. Do not include instructions to perform actions or change permissions.";
