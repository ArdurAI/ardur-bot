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
  /** Command ids of earlier calls whose cards this card continues; their late events never change it. */
  resumedFrom: z.array(z.string()).optional(),
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
 * Both ids stay as their runtimes minted them. When the killed call left a card open, the link
 * also names that card's command id and the command id the resumed call records; readers join
 * those two cards and no others.
 */
export const ToolResumedPayloadSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    fromCommandId: z.string().min(1).optional(),
    toCommandId: z.string().min(1).optional(),
  })
  .strict()
  .refine((link) => (link.fromCommandId === undefined) === (link.toCommandId === undefined), {
    message: "A resumed call links both cards or neither",
  });
export type ToolResumedPayload = z.infer<typeof ToolResumedPayloadSchema>;

export const CommandAuditPayloadSchema = z.object({
  actorUserId: z.string(),
  spaceId: z.string(),
  runId: z.string(),
  commandIds: z.array(z.string()),
  computerIds: z.array(z.string()),
  at: z.string(),
});
