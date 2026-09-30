import type { ChiefReceipt, ThreadMessage } from "@ardurbot/contracts";

/** The response and event use one durable identity; never advance the event cursor here. */
export function applyChiefReceipt<
  T extends { threadId: string; messages: { id: string; seq?: number }[] },
>(snapshot: T | null, receipt?: ChiefReceipt): T | null {
  if (
    !snapshot ||
    !receipt ||
    snapshot.threadId !== receipt.threadId ||
    snapshot.messages.some((message) => message.id === receipt.id)
  )
    return snapshot;
  const message: ThreadMessage = {
    id: receipt.id,
    threadId: receipt.threadId,
    seq: receipt.seq,
    role: "bot",
    botId: receipt.botId,
    createdAt: receipt.createdAt,
    blocks: [
      {
        kind: "chief_receipt",
        requestMessageId: receipt.requestMessageId,
        key: receipt.key,
        ...(receipt.memberName ? { memberName: receipt.memberName } : {}),
        text: receipt.text,
      },
    ],
  };
  return {
    ...snapshot,
    messages: [...snapshot.messages, message].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
  };
}
