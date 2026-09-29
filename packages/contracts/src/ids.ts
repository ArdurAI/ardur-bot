import * as z from "zod";

export const Id = z.string().min(1);
export const IsoDate = z.string().datetime({ offset: true });

export const ActorSchema = z.object({
  userId: Id,
  spaceId: Id,
  email: z.string().email(),
  isDeploymentOwner: z.boolean(),
});
export type Actor = z.infer<typeof ActorSchema>;

// Round-robin palette for newly created bots. These must stay identical to
// GROK_BOT_COLORS in @ardurbot/core (bot-avatar-colors.ts) — core's
// bot-avatar-colors.test.ts enforces the match so assigned colors render
// exactly as chosen instead of snapping to a nearest pigment.
export const BOT_COLORS = [
  "#9A3B1E",
  "#2F4A7A",
  "#4E6B2F",
  "#A84A22",
  "#7A3F6A",
  "#2E6B6B",
  "#7F621B",
  "#5A5F66",
] as const;

export const RunStatus = z.enum([
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const EffectStatus = z.enum(["intended", "completed", "failed", "ambiguous", "reconciled"]);
export type EffectStatus = z.infer<typeof EffectStatus>;

export const MemoryScope = z.enum(["bot", "user"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const SandboxKind = z.enum([
  "ssh",
  "remote-docker",
  "docker",
  "kubernetes",
  "e2b",
  "daytona",
  "box",
  "desktop",
  "fake",
]);
export type SandboxKind = z.infer<typeof SandboxKind>;

export const RunTriggerSchema = z.enum([
  "user",
  "routine",
  "resume",
  "follow_up",
  "reaction",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
  "cloud_agent",
  "comparison",
  "comparison-coordinator",
]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;
