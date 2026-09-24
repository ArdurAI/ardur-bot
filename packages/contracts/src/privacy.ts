import * as z from "zod";
import { ArtifactSchema, ExportManifestSchema } from "./domain.js";
import { MemoryBundleSchema } from "./memory-documents.js";
import { UserPreferencesSchema } from "./preferences.js";

export const AccountExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  account: z.object({
    name: z.string(),
    email: z.string(),
    avatarStyle: z.string(),
    createdAt: z.string(),
  }),
  preferences: UserPreferencesSchema,
  spaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      bots: z.array(ExportManifestSchema),
      memory: MemoryBundleSchema.nullable(),
      uploads: z.array(ArtifactSchema.extend({ contentBase64: z.string() })),
      conversations: z.array(z.object({ id: z.string(), messages: z.array(z.json()) })),
      usage: z.array(z.json()),
      feedback: z.array(z.json()),
      learningConsent: z.array(z.json()),
    }),
  ),
});
