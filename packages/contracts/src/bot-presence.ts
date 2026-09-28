import * as z from "zod";

export const BotAvailabilitySchema = z.enum([
  "idle",
  "busy",
  "queued",
  "waiting-owner",
  "paused",
  "unavailable",
  "unknown",
]);

export const BotPresenceSchema = z.object({
  botId: z.string(),
  name: z.string(),
  title: z.string(),
  roleSummary: z.string(),
  charterRevision: z.number().int().optional(),
  groupIds: z.array(z.string()),
  goalId: z.string().optional(),
  availability: BotAvailabilitySchema,
  activeRunIds: z.array(z.string()),
  activeRunCount: z.number().int().nonnegative(),
  concurrentLimit: z.number().int().positive(),
  currentTaskTitle: z.string().optional(),
  delegationId: z.string().optional(),
  lastActiveAt: z.string().datetime().optional(),
  observedAt: z.string().datetime(),
  staleAfter: z.string().datetime(),
  computer: z.object({
    id: z.string().optional(),
    displayName: z.string().optional(),
    kind: z.string().optional(),
    available: z.boolean().optional(),
  }),
  canMessage: z.boolean(),
  cannotMessageReason: z.string().optional(),
  pendingPeerCount: z.number().int().nonnegative(),
  waitingForBotId: z.string().optional(),
  reviewState: z.string().optional(),
  latestDeliveryId: z.string().optional(),
  latestDeliveryState: z.string().optional(),
  latestPeerBotId: z.string().optional(),
});
export type BotPresence = z.infer<typeof BotPresenceSchema>;
export type BotAvailability = z.infer<typeof BotAvailabilitySchema>;

export const ListBotsInputSchema = z.strictObject({
  group_id: z.string().min(1).optional(),
  availability: BotAvailabilitySchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const ListBotsResultSchema = z.object({
  bots: z.array(BotPresenceSchema),
  observedAt: z.string().datetime(),
  nextCursor: z.string().optional(),
});
