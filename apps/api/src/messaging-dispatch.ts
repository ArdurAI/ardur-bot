import { randomUUID, timingSafeEqual } from "node:crypto";
import type { JobPublisher, MessagingInboundMessage } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import {
  createMessagingDispatch,
  MessagingInstallationSettings,
  telegramEvent,
} from "@ardurbot/adapters";
import type { Actor, ChatInstallationInput } from "@ardurbot/contracts";
import { ChatProviderSchema } from "@ardurbot/contracts";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { DeviceRequestError, deviceDigest, startChannelPairing } from "@ardurbot/db";
import type { Hono } from "hono";
import { requestBodyLimit } from "./request-body-limit.js";

type Deps = {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  jobs: JobPublisher;
  events: ThreadEvents;
};
function owner(actor: Actor) {
  if (!actor.isDeploymentOwner)
    throw new DeviceRequestError("Pair and manage chat accounts at home.");
}
export function createChannelPairing(deps: Deps) {
  const settings = new MessagingInstallationSettings(deps.prisma, deps.secrets);
  return {
    async installations(actor: Actor) {
      owner(actor);
      const rows = await deps.prisma.chatInstallation.findMany({
        where: { userId: actor.userId, spaceId: actor.spaceId, enabled: true },
      });
      return rows.map((row) => ({
        id: row.id,
        provider: ChatProviderSchema.parse(row.provider),
        workspaceId: row.workspaceId,
        botId: row.botId,
      }));
    },
    async configure(actor: Actor, input: ChatInstallationInput) {
      owner(actor);
      return settings.save(input, {
        userId: actor.userId,
        spaceId: actor.spaceId,
        operationId: "chat.configure",
        traceId: randomUUID(),
        signal: AbortSignal.timeout(30_000),
      });
    },
    async start(actor: Actor, input: { installationId: string; botId?: string; scopes: string[] }) {
      owner(actor);
      const row = await deps.prisma.chatInstallation.findFirst({
        where: {
          id: input.installationId,
          userId: actor.userId,
          spaceId: actor.spaceId,
          enabled: true,
        },
      });
      if (!row) throw new DeviceRequestError("Connect a chat bot in Settings first.");
      if (input.botId && input.botId !== row.botId) {
        const bot = await deps.prisma.bot.findFirst({
          where: {
            id: input.botId,
            userId: actor.userId,
            spaceId: actor.spaceId,
            archivedAt: null,
          },
        });
        if (!bot) throw new DeviceRequestError("Choose an available bot.");
        await deps.prisma.$transaction(async (tx) => {
          await tx.chatInstallation.update({
            where: { id: row.id },
            data: { botId: bot.id, revision: { increment: 1 } },
          });
          await tx.messagingRoute.updateMany({
            where: { installationId: row.id },
            data: { botId: bot.id },
          });
        });
      }
      return startChannelPairing(deps.prisma, row.id, input.scopes);
    },
  };
}

/** Preserve the Telegram webhook URL, with the same Dispatch backend as polling. */
export function mountMessagingDispatch(app: Hono, deps: Deps) {
  const settings = new MessagingInstallationSettings(deps.prisma, deps.secrets);
  const dispatch = createMessagingDispatch(deps);
  const path = "/api/v1/messaging/webhook/telegram";
  app.use(path, requestBodyLimit(256 * 1024));
  app.use(path, async (c, next) => {
    const rows = await deps.prisma.chatInstallation.findMany({
      where: { provider: "telegram", enabled: true },
      take: 50,
    });
    if (!rows.length) return next();
    const received = c.req.header("x-telegram-bot-api-secret-token") ?? "";
    const row = rows.find((row) => {
      const config = settings.load(row);
      return (
        config.webhookUrl &&
        config.webhookSecret &&
        timingSafeEqual(
          Buffer.from(deviceDigest(received)),
          Buffer.from(deviceDigest(config.webhookSecret)),
        )
      );
    });
    if (!row || c.req.method !== "POST")
      return c.json({ message: "This request is unavailable." }, 401);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ message: "Invalid chat event." }, 400);
    }
    const event = telegramEvent(payload);
    if (!event) return c.json({ message: "Invalid chat event." }, 400);
    try {
      const config = settings.load(row);
      await dispatch.receive(row, event, [config.botToken, config.webhookSecret ?? ""]);
    } catch {
      return c.json({ message: "Waiting for home." }, 503);
    }
    return c.json({ ok: true });
  });
}

/** A legacy signed Slack webhook for a Dispatch installation cannot bypass channel admission. */
export function createLegacyChatDispatch(deps: Deps, botToken?: string) {
  const settings = new MessagingInstallationSettings(deps.prisma, deps.secrets);
  const dispatch = createMessagingDispatch(deps);
  return async (event: MessagingInboundMessage): Promise<boolean> => {
    if (event.provider !== "slack" || !botToken) return false;
    const rows = await deps.prisma.chatInstallation.findMany({
      where: { provider: "slack", enabled: true },
    });
    const installation = rows.find((row) => settings.load(row).botToken === botToken);
    if (!installation) return false;
    if (event.senderIsBot) return true;
    // SDK events missing immutable provider coordinates cannot fall back to installer authority.
    if (!event.workspaceId || !event.conversationKey || !event.providerEventId) return true;
    await dispatch.receive(
      installation,
      {
        provider: "slack",
        workspaceId: event.workspaceId,
        senderId: event.from,
        eventId: event.providerEventId,
        messageId: event.handle,
        channelId: event.conversationKey,
        ...(event.replyThreadId
          ? { threadId: event.replyThreadId, replyTo: event.replyThreadId }
          : {}),
        private: event.isDirect,
        addressed: event.isDirect || event.kind === "mention" || Boolean(event.replyThreadId),
        text: event.content,
        attachmentCount: event.mediaUrl ? 1 : 0,
        attachmentBytes: 0,
      },
      [botToken],
    );
    return true;
  };
}
