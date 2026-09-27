import * as z from "zod";
import type { BotMessageIntent } from "./events.js";

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
