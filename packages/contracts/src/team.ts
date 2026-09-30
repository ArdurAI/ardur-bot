import { oc } from "@orpc/contract";
import * as z from "zod";
import { BotAvailabilitySchema } from "./bot-presence.js";
import { DelegationRecordSchema, DelegationSnapshotSchema } from "./delegation.js";
import { FailureCategoryIdSchema } from "./failure-categories.js";
import { HostLabelSchema } from "./fleet.js";
import { RuntimeInfoSchema } from "./runtime-pins.js";
export const TeamStateSchema = z.enum([
  "idle",
  "queued",
  "working",
  "waiting-approval",
  "blocked",
  "completed",
  "accepted",
]);
export const TeamRowSchema = z.object({
  botId: z.string(),
  botName: z.string(),
  botColor: z.string().optional(),
  availability: BotAvailabilitySchema.optional(),
  observedAt: z.string().datetime().optional(),
  lastActiveAt: z.string().datetime().optional(),
  currentTaskTitle: z.string().optional(),
  activeRunCount: z.number().int().nonnegative().optional(),
  activeRunIds: z.array(z.string()).optional(),
  pendingPeerCount: z.number().int().nonnegative().optional(),
  waitingForBotId: z.string().optional(),
  latestDeliveryId: z.string().optional(),
  latestDeliveryState: z.string().optional(),
  latestDeliveryGroupId: z.string().optional(),
  latestPeerBotId: z.string().optional(),
  latestPeerBotName: z.string().optional(),
  latestPeerBotColor: z.string().optional(),
  goalId: z.string().optional(),
  reviewState: z.string().optional(),
  trafficPaused: z.boolean().optional(),
  computerName: z.string().nullable().optional(),
  /** A built-in computer, named by clients in their own language instead of computerName. */
  computerBuiltin: z.enum(["host", "local-docker"]).nullable().optional(),
  threadId: z.string().nullable(),
  groupId: z.string().nullable().optional(),
  cursor: z.number().int(),
  state: TeamStateSchema,
  sentence: z.string().nullable(),
  requesterName: z.string().nullable(),
  reason: z.string().nullable(),
  /** The failure category of a blocked card's reason, when it is a known one. */
  reasonCategory: FailureCategoryIdSchema.optional(),
  /** The runtime display name a categorized reason sentence names, when it names one. */
  reasonRuntime: z.string().nullable().optional(),
  action: z.string().nullable(),
  rootTaskId: z.string().nullable(),
  delegationId: z.string().nullable(),
  canStop: z.boolean(),
  canAccept: z.boolean(),
  chain: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.enum(["requester", "worker", "reviewer"]),
    }),
  ),
  delegations: z.array(DelegationRecordSchema),
  executing: DelegationSnapshotSchema.extend({
    runtimeInfo: RuntimeInfoSchema.nullable().optional(),
  }).nullable(),
  usage: z.object({
    /** Measured token total; null when recorded consumption is unavailable, never a fake zero. */
    tokens: z.number().int().nullable(),
    /**
     * True when the total is a lower bound: some recorded consumption is unavailable
     * or only partially counted. Older payloads omit it; missing means a firm total.
     */
    partial: z.boolean().default(false),
    costs: z.array(z.object({ amount: z.number(), provenance: z.string() })),
  }),
});
export type TeamRow = z.infer<typeof TeamRowSchema>;
export const TeamBoardSchema = z.object({
  rows: z.array(TeamRowSchema),
  hostLabel: HostLabelSchema.optional(),
});
export type TeamBoard = z.infer<typeof TeamBoardSchema>;
export const teamContract = { board: oc.input(z.object({})).output(TeamBoardSchema) };
