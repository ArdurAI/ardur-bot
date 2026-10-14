import type { Actor } from "@ardurbot/contracts";
import type { Prisma } from "./client.js";
import { getOwnedGroupTarget } from "./groups.js";
import { getOwnedBot } from "./repos.js";
import { IsolationError } from "./scope.js";

type ThreadReader = Pick<Prisma.TransactionClient, "bot" | "chatGroup" | "externalConversation">;
type ActorScope = Pick<Actor, "spaceId" | "userId">;

/** Shared thread resolution for API targets and run evidence access. */
export async function resolveReadableThreadTarget(
  prisma: ThreadReader,
  actor: ActorScope,
  input: { botId?: string; groupId?: string; threadId?: string },
) {
  if (input.botId) {
    const bot = await getOwnedBot(prisma, actor, input.botId);
    if (!bot.thread) throw new IsolationError();
    let threadId = bot.thread.id;
    if (input.threadId && input.threadId !== threadId) {
      const conversation = await prisma.externalConversation.findFirst({
        where: {
          botId: bot.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          thread: { id: input.threadId },
        },
        select: { id: true },
      });
      if (!conversation) throw new IsolationError();
      threadId = input.threadId;
    }
    return { kind: "bot" as const, botId: bot.id, threadId, bot };
  }
  if (input.groupId) {
    const group = await getOwnedGroupTarget(prisma, actor, input.groupId);
    if (!group.thread) throw new IsolationError();
    return {
      kind: "group" as const,
      groupId: group.id,
      threadId: group.thread.id,
      group: { ...group, thread: group.thread },
    };
  }
  throw new IsolationError();
}

/** Membership, run space, and the owning thread must all permit the reader. */
export async function assertRunEvidenceAccess(
  prisma: ThreadReader & Pick<Prisma.TransactionClient, "spaceMember" | "run">,
  actor: ActorScope,
  runId: string,
) {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  if (!member) throw new IsolationError();
  const run = await prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId },
    include: { thread: { select: { groupId: true } } },
  });
  if (!run) throw new IsolationError();
  const target = await resolveReadableThreadTarget(prisma, actor, {
    ...(run.thread.groupId ? { groupId: run.thread.groupId } : { botId: run.botId }),
    threadId: run.threadId,
  });
  if (target.threadId !== run.threadId) throw new IsolationError();
  return run;
}
