import {
  ACTIVE_RUN_STATUSES,
  type MemberRun,
  memberActivity,
  renderBotPresenceDirectory,
  renderMemberDirectory,
  SKILLS_SHOWN,
  taskCardGoal,
} from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { loadBotPresence } from "@ardurbot/db";

export { loadChiefMemberFacts } from "@ardurbot/db";

const DESK_DIRECTORY_LIMIT = 40;

/** Select a whole room before bounding the broader desk directory. */
export async function loadRunBotDirectory(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
  selfId: string,
  groupId: string | undefined,
  canSend: boolean,
): Promise<string | undefined> {
  const result = await loadBotPresence(prisma, scope, {
    callerBotId: selfId,
    canSend,
    ...(groupId ? { groupId, visibleGroupId: groupId } : { limit: DESK_DIRECTORY_LIMIT }),
  });
  return renderBotPresenceDirectory(result.bots, selfId, groupId);
}

const runFields = {
  botId: true,
  status: true,
  threadId: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  leaseExpiresAt: true,
  error: true,
  taskId: true,
  delegationId: true,
} as const;

/**
 * The room coordinator's member list: who each member is and, from run records alone, what
 * it is doing now and last did here. Reads only; it never wakes a member or calls a model.
 */
export async function loadRoomMemberDirectory(
  prisma: PrismaClient,
  { spaceId, userId }: { spaceId: string; userId: string },
  groupId: string,
  selfId: string,
  now = new Date(),
): Promise<string | undefined> {
  const scope = { spaceId, userId };
  const group = await prisma.chatGroup.findFirst({
    where: { ...scope, id: groupId, archivedAt: null },
    select: {
      thread: { select: { id: true } },
      members: {
        where: { bot: { archivedAt: null } },
        orderBy: { createdAt: "asc" },
        select: {
          bot: {
            select: {
              id: true,
              name: true,
              title: true,
              description: true,
              computer: { select: { state: true } },
            },
          },
        },
      },
    },
  });
  const roomThreadId = group?.thread?.id;
  const members = (group?.members ?? [])
    .map((member) => member.bot)
    .filter((bot) => bot.id !== selfId);
  if (!roomThreadId || !members.length) return undefined;
  const botIds = members.map((bot) => bot.id);
  const [active, lastHere, latest, skills] = await Promise.all([
    prisma.run.findMany({
      where: { ...scope, botId: { in: botIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: runFields,
    }),
    prisma.run.findMany({
      where: {
        ...scope,
        threadId: roomThreadId,
        botId: { in: botIds },
        status: { in: ["completed", "failed", "cancelled"] },
      },
      distinct: ["botId"],
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: runFields,
    }),
    prisma.run.findMany({
      where: { ...scope, botId: { in: botIds } },
      distinct: ["botId"],
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { botId: true, createdAt: true, startedAt: true, completedAt: true },
    }),
    prisma.taughtSkill.findMany({
      where: { ...scope, botId: { in: botIds }, status: "saved", enabled: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { botId: true, name: true, goal: true },
    }),
  ]);
  // Task text is loaded only for this room's runs; other threads stay private.
  const roomRuns = [...active, ...lastHere].filter((run) => run.threadId === roomThreadId);
  const [tasks, cards] = await Promise.all([
    prisma.task.findMany({
      where: { id: { in: roomRuns.map((run) => run.taskId) } },
      select: { id: true, prompt: true },
    }),
    prisma.delegation.findMany({
      where: {
        id: { in: roomRuns.flatMap((run) => (run.delegationId ? [run.delegationId] : [])) },
      },
      select: { id: true, card: true },
    }),
  ]);
  const record = (run: (typeof active)[number]): MemberRun => ({
    ...run,
    task:
      run.threadId === roomThreadId
        ? (taskCardGoal(cards.find((card) => card.id === run.delegationId)?.card) ??
          tasks.find((task) => task.id === run.taskId)?.prompt)
        : undefined,
  });
  return renderMemberDirectory(
    members.map((bot) => {
      const last = latest.find((run) => run.botId === bot.id);
      const lastHereRun = lastHere.find((run) => run.botId === bot.id);
      return {
        id: bot.id,
        name: bot.name,
        title: bot.title,
        description: bot.description,
        skills: skills
          .filter((skill) => skill.botId === bot.id)
          .slice(0, SKILLS_SHOWN)
          .map((skill) => skill.name || skill.goal),
        activity: memberActivity({
          roomThreadId,
          computerState: bot.computer?.state,
          activeRuns: active.filter((run) => run.botId === bot.id).map(record),
          lastRoomRun: lastHereRun ? record(lastHereRun) : null,
          lastActiveAt: last ? (last.completedAt ?? last.startedAt ?? last.createdAt) : null,
          now,
        }),
      };
    }),
  );
}
