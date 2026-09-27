import type { MessageBlock } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";

/** Quiet deliveries enter a turn only through its claimed required context. */
export async function quietHistoryDeliveryIds(
  prisma: PrismaClient,
  threadId: string,
  messageBlocks: MessageBlock[][],
): Promise<ReadonlySet<string>> {
  const deliveryIds = [
    ...new Set(
      messageBlocks.flatMap((blocks) =>
        blocks.flatMap((block) =>
          block.kind === "bot_message_received" && block.deliveryId ? [block.deliveryId] : [],
        ),
      ),
    ),
  ];
  if (deliveryIds.length === 0) return new Set();
  const receipts = await prisma.botMessageDelivery.findMany({
    where: {
      id: { in: deliveryIds },
      recipientThreadId: threadId,
      OR: [{ intent: { in: ["status", "fyi"] } }, { intent: "result", inReplyToDeliveryId: null }],
    },
    select: { id: true },
  });
  return new Set(receipts.map((receipt) => receipt.id));
}
