import { z } from "zod";

export const LOCAL_IMPORT_TOOLS = [
  "claude-code",
  "codex",
  "kimi",
  "cursor",
  "gemini",
  "hermes",
  "claude-desktop",
] as const;
export const LOCAL_IMPORT_CATEGORIES = [
  "instructions",
  "memories",
  "skills",
  "servers",
  "plugins",
  "other",
] as const;
export const LocalImportToolSchema = z.enum(LOCAL_IMPORT_TOOLS);
export const LocalImportCategorySchema = z.enum(LOCAL_IMPORT_CATEGORIES);
export type LocalImportTool = z.infer<typeof LocalImportToolSchema>;
export type LocalImportCategory = z.infer<typeof LocalImportCategorySchema>;
export const LOCAL_IMPORT_BYTES = 96 * 1024;
export const LOCAL_IMPORT_ITEMS = 4096;
/** A run reports every failed item in its count and lists at most this many. */
export const LOCAL_IMPORT_FAILURES = 20;
export const LOCAL_IMPORT_PRIVACY =
  "Ardur Bot reads instructions, memories, skills and server lists from these tools on this computer and never their sign-ins, tokens or chat history.";
export const LOCAL_IMPORT_EXCLUSIONS =
  "Sign-in files (auth.json, credentials and oauth_creds.json), cookies, tokens, credential backups, session transcripts, chat histories, history.jsonl, telemetry and caches are never read; server lists retain environment variable names only.";
export const LOCAL_IMPORT_TOOL_NAMES: Record<LocalImportTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  hermes: "Hermes",
  "claude-desktop": "Claude desktop",
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
export const LocalImportRootsSchema = z.partialRecord(
  LocalImportToolSchema,
  z.string().min(1).max(4096),
);
export const LocalImportSelectionSchema = z.partialRecord(
  LocalImportToolSchema,
  z.array(LocalImportCategorySchema).max(6),
);
export const LocalImportItemSchema = z.strictObject({
  id,
  tool: LocalImportToolSchema,
  category: LocalImportCategorySchema,
  name: z.string().max(200),
  relativePath: z.string().max(1024),
  sourcePathHash: hash,
  contentHash: hash,
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
  importable: z.boolean(),
  reason: z.string().max(240).optional(),
  folder: z.string().max(1024).optional(),
});
export type LocalImportItem = z.infer<typeof LocalImportItemSchema>;
export const LocalImportManifestSchema = z.strictObject({
  scanId: id,
  scannedAt: z.string().datetime(),
  platform: z.enum(["darwin", "linux", "win32"]),
  sources: z
    .array(
      z.strictObject({
        tool: LocalImportToolSchema,
        detected: z.boolean(),
        defaultMissing: z.boolean(),
        counts: z.record(LocalImportCategorySchema, z.number().int().nonnegative()),
        memoryFolders: z.number().int().nonnegative(),
      }),
    )
    .max(7),
  items: z.array(LocalImportItemSchema).max(LOCAL_IMPORT_ITEMS),
  limited: z.boolean(),
  // Present when every limit that applied could count the files it left out.
  unscanned: z.number().int().positive().optional(),
});
export type LocalImportManifest = z.infer<typeof LocalImportManifestSchema>;
export const ImportedProvenanceSchema = z.strictObject({
  tool: LocalImportToolSchema,
  relativePath: z.string().max(1024),
  sourcePathHash: hash,
  contentHash: hash,
  modifiedAt: z.string().datetime(),
  importedAt: z.string().datetime(),
  // The revision written by the import; later edits and restores retain this original value.
  documentRevision: z.number().int().positive().optional(),
  kind: LocalImportCategorySchema,
  authorizesIntent: z.literal(false),
});
export type ImportedProvenance = z.infer<typeof ImportedProvenanceSchema>;
export const LocalImportServerSchema = z.strictObject({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  transport: z.enum(["stdio", "streamable_http", "sse"]),
  command: z.string().max(1024).optional(),
  args: z.array(z.string().max(2048)).max(64),
  endpoint: z.string().max(2048).optional(),
  envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(64),
  headerNames: z.array(z.string().regex(/^[A-Za-z0-9-]+$/)).max(32),
  headerEnv: z
    .record(
      z.string().regex(/^[A-Za-z0-9-]+$/),
      z.strictObject({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        bearer: z.boolean(),
      }),
    )
    .default({}),
});
export type LocalImportServer = z.infer<typeof LocalImportServerSchema>;
export const LocalImportReadSchema = z.strictObject({
  item: LocalImportItemSchema,
  content: z.string().max(LOCAL_IMPORT_BYTES),
  server: LocalImportServerSchema.optional(),
});
export type LocalImportRead = z.infer<typeof LocalImportReadSchema>;
export const LocalImportActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("scan") }),
  z.strictObject({ action: z.literal("preview"), scanId: id, itemId: id }),
  z.strictObject({
    action: z.literal("import"),
    scanId: id,
    categories: z.array(LocalImportCategorySchema).min(1).max(6),
    tool: LocalImportToolSchema.optional(),
    // Retries one listed item without changing the saved selection.
    itemId: id.optional(),
  }),
  z.strictObject({ action: z.literal("undo"), tool: LocalImportToolSchema }),
]);
export type LocalImportAction = z.infer<typeof LocalImportActionSchema>;
export const LocalImportResultSchema = z.strictObject({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type LocalImportResult = z.infer<typeof LocalImportResultSchema>;
export const LocalImportFailureSchema = z.strictObject({
  itemId: id,
  tool: LocalImportToolSchema,
  category: LocalImportCategorySchema,
  relativePath: z.string().max(1024),
  // "credential": the text looks like it holds a credential. Details stay in the worker log.
  reason: z.enum(["credential", "failed"]),
});
export type LocalImportFailure = z.infer<typeof LocalImportFailureSchema>;
/** Why a whole run stopped: the host transport failed, the scan is stale, or anything else. */
export const LocalImportStopSchema = z.enum(["host", "rescan", "failed"]);
export type LocalImportStop = z.infer<typeof LocalImportStopSchema>;
/** RPC error code for a custom folder outside the owner's home; clients name the fix. */
export const LOCAL_IMPORT_INVALID_FOLDER_CODE = "LOCAL_IMPORT_INVALID_FOLDER";
export const LocalImportStatusSchema = z.strictObject({
  manifest: LocalImportManifestSchema.nullable(),
  autoImport: z.boolean(),
  importedAt: z.string().datetime().nullable(),
  roots: LocalImportRootsSchema,
  selection: LocalImportSelectionSchema,
  imported: z.array(
    z.strictObject({ tool: LocalImportToolSchema, count: z.number().int().nonnegative() }),
  ),
});
export const LocalImportResponseSchema = z.strictObject({
  manifest: LocalImportManifestSchema.optional(),
  preview: LocalImportReadSchema.optional(),
  result: LocalImportResultSchema.optional(),
  failures: z.array(LocalImportFailureSchema).max(LOCAL_IMPORT_FAILURES).optional(),
  stopped: LocalImportStopSchema.optional(),
});
export type LocalImportResponse = z.infer<typeof LocalImportResponseSchema>;
export type LocalImportSummary = { result: LocalImportResult; failures: LocalImportFailure[] };
/** Adds one import response to what the page shows; a retried item leaves the failure list. */
export function addLocalImportResult(
  summary: LocalImportSummary | null,
  response: LocalImportResponse,
  retried?: LocalImportFailure,
): LocalImportSummary {
  const result: LocalImportResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    ...summary?.result,
  };
  if (retried) result.failed = Math.max(0, result.failed - 1);
  for (const key of Object.keys(result) as (keyof LocalImportResult)[])
    result[key] += response.result?.[key] ?? 0;
  const failures = [
    ...(summary?.failures ?? []).filter((failure) => failure.itemId !== retried?.itemId),
    ...(response.failures ?? []),
  ].slice(0, LOCAL_IMPORT_FAILURES);
  return { result, failures };
}
export const LocalImportJobSchema = z.strictObject({
  requestId: z.string().uuid(),
  spaceId: z.string().min(1).max(160),
  userId: z.string().min(1).max(160),
  action: LocalImportActionSchema,
});
export type LocalImportJob = z.infer<typeof LocalImportJobSchema>;
