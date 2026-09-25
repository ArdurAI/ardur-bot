import { oc } from "@orpc/contract";
import * as z from "zod";

export const ChatProviderSchema = z.enum(["telegram", "discord", "slack"]);
export type ChatProvider = z.infer<typeof ChatProviderSchema>;
export const CHANNEL_SCOPES = ["read", "dispatch", "steer", "stop", "approve", "ordinary"] as const;
export const CHAT_COPY = {
  accepted: "Accepted — working on it.",
  waiting: "Waiting for home.",
  stopped: "Stopped.",
  stronger: "Approve this on your Mac or phone.",
  pair: "Pair your account with Ardur Bot first.",
  secrets: "Add secrets in Settings, not in chat.",
} as const;
const id = z.string().min(1).max(256);
export const ChatEventSchema = z.object({
  eventId: id,
  provider: ChatProviderSchema,
  workspaceId: id,
  senderId: id,
  channelId: id,
  messageId: id,
  threadId: id.optional(),
  replyTo: id.optional(),
  private: z.boolean(),
  addressed: z.boolean().optional(),
  text: z.string().max(32_000),
  action: z.string().max(100).optional(),
  attachments: z
    .array(z.object({ name: z.string().max(160), text: z.string().max(24_000) }))
    .max(3)
    .optional(),
  rejectedAttachment: z.enum(["size", "type", "secret"]).optional(),
  attachmentBytes: z.number().int().nonnegative().default(0),
  attachmentCount: z.number().int().nonnegative().default(0),
});
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type ChatDestination = Pick<ChatEvent, "workspaceId" | "channelId" | "threadId">;
export interface ChatCard {
  text: string;
  actions?: Array<{ label: string; value: string }>;
}
export const ChatInstallationInputSchema = z
  .strictObject({
    provider: ChatProviderSchema,
    botToken: z.string().trim().min(1).max(512),
    appToken: z.string().trim().max(512).optional(),
    workspaceId: z.string().trim().min(1).max(128),
    botId: id,
    webhookUrl: z.url().startsWith("https://").optional(),
    webhookSecret: z.string().trim().min(16).max(128).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider === "slack" && !value.appToken)
      ctx.addIssue({ code: "custom", message: "Enter the app token.", path: ["appToken"] });
    if (value.webhookUrl && (value.provider !== "telegram" || !value.webhookSecret))
      ctx.addIssue({
        code: "custom",
        message: "Enter the webhook secret.",
        path: ["webhookSecret"],
      });
  });
export type ChatInstallationInput = z.infer<typeof ChatInstallationInputSchema>;
export const channelPairingContract = {
  installations: oc.output(
    z.array(z.object({ id, provider: ChatProviderSchema, workspaceId: id, botId: id })),
  ),
  configure: oc.input(ChatInstallationInputSchema).output(z.object({ id })),
  start: oc
    .input(
      z.object({
        installationId: id,
        botId: id.optional(),
        scopes: z.array(z.enum(CHANNEL_SCOPES)).default([...CHANNEL_SCOPES]),
      }),
    )
    .output(z.object({ code: z.string(), expiresAt: z.string() })),
};

/** Reject likely credentials before content reaches a durable queue, prompt, or audit. */
export function looksLikeChatSecret(text: string): boolean {
  return /(?:(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@|\b(?=[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY))[A-Z0-9_]+\s*=\s*\S+|(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|xox[baprs]-[\w-]{10,}|xapp-[\w-]{10,}|AKIA[A-Z0-9]{16})|(?:^|[^\w-])(?=[\w-]*\beyJ[\w-])[\w-]+\.[\w-]+\.[\w-]+|\b\d{6,}:[A-Za-z0-9_-]{25,}|\bBearer\s+\S+|(?:password|secret|api[_ -]?key|access[_ -]?token|bot[_ -]?token)\s*[:=]\s*\S+)/i.test(
    text,
  );
}
