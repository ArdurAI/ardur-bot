import type { ChatCard, ChatDestination } from "@ardurbot/contracts";
import { CHAT_COPY, ChatEventSchema, looksLikeChatSecret } from "@ardurbot/contracts";
import type { ChatInstallation, PrismaClient } from "@ardurbot/db";
import type { createMessagingDispatch } from "./dispatch.js";
import type { ChatTransport } from "./transport.js";
import { ProviderResponseError } from "./transport.js";

export async function drainChatInbox(
  prisma: PrismaClient,
  installation: ChatInstallation,
  dispatch: ReturnType<typeof createMessagingDispatch>,
) {
  const entries = await prisma.chatInbox.findMany({
    where: { installationId: installation.id, consumedAt: null },
    orderBy: { receivedAt: "asc" },
    take: 32,
  });
  for (const entry of entries) {
    const event = ChatEventSchema.safeParse(entry.event);
    if (event.success) await dispatch.consume(installation, event.data);
    await prisma.chatInbox.update({
      where: {
        installationId_eventId: { installationId: installation.id, eventId: entry.eventId },
      },
      data: { consumedAt: new Date(), event: {} },
    });
  }
}

/** Pending -> sending is durable. An interrupted or ambiguous send stays uncertain, never blindly retried. */
export async function deliverChatOutbox(
  prisma: PrismaClient,
  installation: ChatInstallation,
  transport: ChatTransport,
  signal: AbortSignal,
  secrets: string[],
) {
  const rows = await prisma.chatOutbox.findMany({
    where: {
      installationId: installation.id,
      state: "pending",
      OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: 32,
  });
  for (const row of rows) {
    signal.throwIfAborted();
    if (row.taskId) {
      const origin = await prisma.messagingTaskOrigin.findUnique({ where: { taskId: row.taskId } });
      const grant = origin
        ? await prisma.deviceGrant.findFirst({ where: { id: origin.grantId, revokedAt: null } })
        : null;
      const member = grant
        ? await prisma.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId: grant.spaceId, userId: grant.userId } },
          })
        : null;
      if (!grant || !member || !grant.scopes.includes("read")) {
        await prisma.chatOutbox.update({ where: { id: row.id }, data: { state: "suppressed" } });
        continue;
      }
    }
    const claimed = await prisma.chatOutbox.updateMany({
      where: { id: row.id, state: "pending" },
      data: { state: "sending" },
    });
    if (!claimed.count) continue;
    let card = row.card as unknown as ChatCard;
    if (
      looksLikeChatSecret(card.text) ||
      secrets.some((secret) => secret && card.text.includes(secret))
    )
      card = { text: CHAT_COPY.secrets };
    try {
      const providerMessageId = await transport.send(
        row.destination as unknown as ChatDestination,
        card,
        signal,
        {
          sentChunks: row.sentChunks,
          firstMessageId: row.providerMessageId ?? "",
          sent: async (index, messageId) => {
            await prisma.chatOutbox.update({
              where: { id: row.id },
              data: {
                sentChunks: index + 1,
                providerMessageIds: { push: messageId },
                ...(index === 0 ? { providerMessageId: messageId } : {}),
              },
            });
          },
        },
      );
      if (!providerMessageId) throw new Error("Missing chat receipt.");
      await prisma.chatOutbox.update({
        where: { id: row.id },
        data: { state: "sent", providerMessageId },
      });
      if (row.key.startsWith("summary:") && row.taskId)
        await prisma.dispatchSummary.updateMany({
          where: { taskId: row.taskId },
          data: { acknowledgedAt: new Date() },
        });
    } catch (error) {
      // A 429 explicitly says no message was accepted. Network failures provide no such proof.
      const retry = error instanceof ProviderResponseError && error.status === 429;
      await prisma.chatOutbox.update({
        where: { id: row.id },
        data: {
          state: retry ? "pending" : "uncertain",
          retryAt: retry ? new Date(Date.now() + (error.retryAfterMs ?? 1000)) : null,
        },
      });
      if (retry) break;
    }
  }
}
