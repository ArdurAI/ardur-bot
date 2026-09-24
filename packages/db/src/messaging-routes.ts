import type { ChatCard, ChatDestination, ChatEvent } from "@ardurbot/contracts";
import { CHAT_COPY, canonicalDispatchJson, looksLikeChatSecret } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { DeviceRequestError, deviceDigest } from "./device-grants.js";
import { answerWaitingRunWithTextInTransaction } from "./events.js";

export type ChannelDispatchOrigin = Pick<
  ChatEvent,
  "provider" | "workspaceId" | "channelId" | "threadId" | "messageId" | "private"
> & { installationId: string };
export async function enqueueChat(
  tx: Prisma.TransactionClient | PrismaClient,
  input: {
    key: string;
    installationId: string;
    taskId?: string;
    destination: ChatDestination;
    card: ChatCard;
  },
): Promise<void> {
  const client = tx as PrismaClient;
  if (typeof client.$transaction === "function")
    return client.$transaction((transaction) => enqueueChat(transaction, input));
  await tx.$queryRaw`SELECT id FROM chat_installations WHERE id = ${input.installationId} FOR UPDATE`;
  const existing = await tx.chatOutbox.findUnique({ where: { key: input.key } });
  if (existing) return;
  if (
    (await tx.chatOutbox.count({
      where: { installationId: input.installationId, state: { in: ["pending", "sending"] } },
    })) >= 256
  )
    throw new DeviceRequestError("Waiting for home.", 429);
  const card = looksLikeChatSecret(canonicalDispatchJson(input.card))
    ? { text: CHAT_COPY.secrets }
    : input.card;
  await tx.chatOutbox.upsert({
    where: { key: input.key },
    create: {
      ...input,
      card: {
        text: card.text,
        ...(card.actions
          ? {
              actions: card.actions.map((action) => ({ label: action.label, value: action.value })),
            }
          : {}),
      },
      destination: {
        workspaceId: input.destination.workspaceId,
        channelId: input.destination.channelId,
        ...(input.destination.threadId ? { threadId: input.destination.threadId } : {}),
      },
    },
    update: {},
  });
}

/** Called only by authenticated transports. Raw payloads and credential-like text never enter the inbox. */
export async function acceptChatEvent(
  prisma: PrismaClient,
  installationId: string,
  event: ChatEvent,
) {
  const key = { installationId, eventId: event.eventId };
  const fingerprint = deviceDigest(canonicalDispatchJson(event));
  const rejected =
    event.rejectedAttachment === "secret" ||
    looksLikeChatSecret(canonicalDispatchJson([event.text, event.action, event.attachments]))
      ? CHAT_COPY.secrets
      : event.rejectedAttachment ||
          event.attachmentCount !== (event.attachments?.length ?? 0) ||
          event.attachmentBytes > 256_000 ||
          event.text.length +
            (event.attachments ?? []).reduce((sum, item) => sum + item.text.length, 0) >
            32_000
        ? "Send text here; add files at home."
        : null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM chat_installations WHERE id = ${installationId} FOR UPDATE`;
    const replay = await tx.chatInbox.findUnique({ where: { installationId_eventId: key } });
    if (replay) {
      if (replay.fingerprint !== fingerprint)
        throw new DeviceRequestError("This event changed.", 409);
      return;
    }
    if ((await tx.chatInbox.count({ where: { installationId, consumedAt: null } })) >= 256)
      throw new DeviceRequestError("Waiting for home.", 429);
    // Pairing codes also stay out of persisted content. Their redemption happens before inboxing.
    await tx.chatInbox.create({
      data: {
        ...key,
        fingerprint,
        event: rejected ? {} : (event as Prisma.InputJsonValue),
        consumedAt: rejected ? new Date() : null,
      },
    });
    if (rejected)
      await enqueueChat(tx, {
        key: `reject:${installationId}:${event.eventId}`,
        installationId,
        destination: event,
        card: { text: rejected },
      });
  });
}

export async function findChatReplyTask(
  prisma: PrismaClient,
  installationId: string,
  grantId: string,
  event: ChatEvent,
) {
  const reply = event.replyTo ?? event.threadId;
  if (!reply) return null;
  const deliveries = await prisma.chatOutbox.findMany({
    where: {
      installationId,
      OR: [{ providerMessageId: reply }, { providerMessageIds: { has: reply } }],
      taskId: { not: null },
    },
    take: 10,
  });
  return prisma.messagingTaskOrigin.findFirst({
    where: {
      installationId,
      grantId,
      taskId: { in: deliveries.flatMap((item) => (item.taskId ? [item.taskId] : [])) },
      channelId: event.channelId,
      workspaceId: event.workspaceId,
    },
  });
}

/** A typed question can resume a run; text can never impersonate an approval or presence action. */
export async function answerChannelQuestion(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    answeredByUserId: string;
    answer: string;
  },
) {
  const messages = await tx.message.findMany({
    where: { runId: input.runId, threadId: input.threadId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 50,
  });
  const blocks = messages.flatMap((message) =>
    Array.isArray(message.blocks) ? message.blocks : [],
  );
  const ask = blocks.find(
    (block) =>
      block &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      block.kind === "ask" &&
      block.status !== "answered",
  );
  if (
    !ask ||
    typeof ask !== "object" ||
    Array.isArray(ask) ||
    ask.approvalEffectId ||
    ask.input === "secret" ||
    (Array.isArray(ask.actions) && ask.actions.length)
  )
    throw new DeviceRequestError(CHAT_COPY.stronger);
  const answered = await answerWaitingRunWithTextInTransaction(tx, input);
  if (!answered) throw new DeviceRequestError("This question was already answered.", 409);
}
