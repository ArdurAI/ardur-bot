import { oc } from "@orpc/contract";
import * as z from "zod";
import type { BotMessageIntent } from "./events.js";
import { Id } from "./ids.js";

export const BotMessageDeliveryState = z.enum([
  "held",
  "queued",
  "delivered",
  "read",
  "replied",
  "denied",
  "expired",
  "cancelled",
  "failed",
]);
export type BotMessageDeliveryState = z.infer<typeof BotMessageDeliveryState>;

export const BotMessageWakeState = z.enum(["pending", "bound", "consumed", "cancelled"]);
export type BotMessageWakeState = z.infer<typeof BotMessageWakeState>;

export const BOT_MESSAGE_BATCH_MAX_BODIES = 8;
export const BOT_MESSAGE_BATCH_MAX_CHARACTERS = 16_000;
export const BOT_MESSAGE_PENDING_MAX = 20;
export const BOT_MESSAGE_UNRESOLVED_PER_RUN_MAX = 4;

export const PeerEffectDescriptorSchema = z
  .object({
    kind: z.enum([
      "connector-write",
      "mcp-write",
      "host-command",
      "secret-use",
      "spend",
      "delete",
      "archive",
      "publish",
      "standing-instructions",
      "unknown",
    ]),
    toolName: z.string().trim().min(1).max(200).optional(),
    resourceRef: Id.optional(),
    argsDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type PeerEffectDescriptor = z.infer<typeof PeerEffectDescriptorSchema>;

export const PeerEffectDescriptorsSchema = z.array(PeerEffectDescriptorSchema).max(10);
export const BotCommunicationPolicySchema = z.object({
  scope: z.enum(["space", "group"]),
  groupId: Id.nullable(),
  enabled: z.boolean(),
  paused: z.boolean(),
  effectivePaused: z.boolean(),
  revision: z.number().int().positive(),
});
export type BotCommunicationPolicy = z.infer<typeof BotCommunicationPolicySchema>;

export const botCommsContract = {
  getPolicy: oc.input(z.object({ groupId: Id.optional() })).output(BotCommunicationPolicySchema),
  setPaused: oc
    .input(
      z.object({
        scope: z.enum(["space", "group"]),
        groupId: Id.optional(),
        paused: z.boolean(),
        expectedRevision: z.number().int().positive(),
      }),
    )
    .output(BotCommunicationPolicySchema),
  listDeliveries: oc
    .input(
      z.object({
        conversationId: Id.optional(),
        botId: Id.optional(),
        cursor: Id.optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            id: Id,
            conversationId: Id,
            senderBotId: Id,
            recipientBotId: Id,
            intent: z.string(),
            state: BotMessageDeliveryState,
            createdAt: z.string().datetime(),
            expiresAt: z.string().datetime(),
            requestedEffects: PeerEffectDescriptorsSchema,
          }),
        ),
        nextCursor: Id.nullable(),
      }),
    ),
};

export function botMessageNeedsWake(
  intent: z.infer<typeof BotMessageIntent>,
  linkedParent: boolean,
): boolean {
  return intent === "request" || intent === "question" || (intent === "result" && linkedParent);
}

export function canAppendBotMessageToBatch(
  currentBodies: number,
  currentPromptCharacters: number,
  nextPromptCharacters: number,
): boolean {
  return (
    currentBodies < BOT_MESSAGE_BATCH_MAX_BODIES &&
    currentPromptCharacters + nextPromptCharacters + (currentBodies > 0 ? 2 : 0) <=
      BOT_MESSAGE_BATCH_MAX_CHARACTERS
  );
}
