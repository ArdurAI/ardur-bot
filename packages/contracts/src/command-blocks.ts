import * as z from "zod";

export const COMMAND_OUTPUT_LIMIT = 64 * 1024;
export const COMMAND_TRUNCATED = "[Output truncated]";
export const COMMAND_SUPPRESSED = "[Output redacted: sensitive command]";
export const COMMAND_NOT_RECORDED = "Not recorded";

export const CommandOutcomeSchema = z.enum([
  "waiting",
  "running",
  "completed",
  "cancelled",
  "unknown",
]);

/** Only this validated, unchanged request may be retained for exact replay. */
export const CommandRequestSchema = z
  .object({
    command: z.string().min(1).max(16_384),
    cwd: z.string().max(4096).optional(),
  })
  .strict();

export const CommandBlockSchema = z.object({
  commandId: z.string(),
  runId: z.string(),
  attemptId: z.string().nullable(),
  executionId: z.string(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  computerId: z.string().nullable(),
  computer: z.string().nullable(),
  startedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  outcome: CommandOutcomeSchema,
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  error: z.string().nullable(),
  redacted: z.boolean(),
  truncated: z.boolean(),
  replayOf: z.string().nullable(),
  rerunDisabledReason: z.string().nullable(),
  /** Lease fence of the attempt that wrote this block; blocks recorded without one count as 0. */
  fence: z.number().int().nonnegative().optional(),
});
export type CommandBlock = z.infer<typeof CommandBlockSchema>;

export const CommandEventPayloadSchema = z.object({
  block: CommandBlockSchema,
  replay: z
    .object({
      request: CommandRequestSchema,
      computerFingerprint: z.string(),
    })
    .nullable()
    .optional(),
});
export type CommandEventPayload = z.infer<typeof CommandEventPayloadSchema>;

/**
 * `agent.tool.resumed`: the call `to` repeats the call `from` that a killed attempt left open.
 * Both ids stay as their runtimes minted them; readers join the two calls through this link.
 */
export const ToolResumedPayloadSchema = z
  .object({ from: z.string().min(1), to: z.string().min(1) })
  .strict();
export type ToolResumedPayload = z.infer<typeof ToolResumedPayloadSchema>;

export const CommandAuditPayloadSchema = z.object({
  actorUserId: z.string(),
  spaceId: z.string(),
  runId: z.string(),
  commandIds: z.array(z.string()),
  computerIds: z.array(z.string()),
  at: z.string(),
});
