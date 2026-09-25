import type { DispatchInput } from "@ardurbot/contracts";
import type { ChannelDispatchOrigin, DeviceGrant, PrismaClient } from "@ardurbot/db";
import { admitDispatch, DeviceRequestError } from "@ardurbot/db";
import { routeIncoming } from "./route.js";

/** Routing runs inside admission, after nonce replay and before authority is checked for the target. */
export function admitRoutedDispatch(
  prisma: PrismaClient,
  grant: DeviceGrant,
  input: DispatchInput,
  origin?: ChannelDispatchOrigin,
) {
  return admitDispatch(prisma, grant, input, origin, async (tx, defaults) => {
    const [bots, space, reply] = await Promise.all([
      tx.bot.findMany({
        where: {
          spaceId: grant.spaceId,
          userId: grant.userId,
          archivedAt: null,
          thread: { isNot: null },
        },
        include: { thread: true },
        orderBy: { createdAt: "asc" },
      }),
      tx.space.findUnique({ where: { id: grant.spaceId }, select: { coordinatorBotId: true } }),
      input.replyToTaskId
        ? tx.run.findFirst({
            where: { taskId: input.replyToTaskId, spaceId: grant.spaceId, userId: grant.userId },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),
    ]);
    if (input.botId && !bots.some((bot) => bot.id === input.botId))
      throw new DeviceRequestError("This bot is unavailable; choose another bot.", 403);
    const last = defaults.defaultBotId
      ? await tx.run.findFirst({
          where: {
            botId: defaults.defaultBotId,
            spaceId: grant.spaceId,
            userId: grant.userId,
            originDeviceGrantId: grant.id,
          },
          orderBy: { createdAt: "desc" },
        })
      : null;
    // Room isolation and reply task binding remain owned by admitDispatch, including authorization.
    const target = routeIncoming({
      text: input.text,
      bots: bots.map((bot) => ({ botId: bot.id, name: bot.name, threadId: bot.thread!.id })),
      mentionBotIds: input.botId && !input.replyToTaskId ? [input.botId] : [],
      replyTo: reply
        ? {
            botId: reply.botId,
            threadId: bots.find((bot) => bot.id === reply.botId)?.thread?.id ?? "",
          }
        : null,
      groupCoordinatorId: defaults.groupCoordinatorId,
      lastActiveThread: last
        ? {
            botId: last.botId,
            threadId: bots.find((bot) => bot.id === last.botId)?.thread?.id ?? "",
          }
        : null,
      spaceCoordinatorId: space?.coordinatorBotId,
      defaultBotId: defaults.defaultBotId,
    });
    return target;
  });
}
