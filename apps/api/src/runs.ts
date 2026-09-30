import type { Actor, FailureCategoryId, RunActivityRow } from "@ardurbot/contracts";
import {
  FailureCategoryIdSchema,
  failureCategoryFromText,
  MessageBlock,
  RunTriggerSchema,
  RuntimePinSchema,
  RuntimeProblemSchema,
  runtimeNames,
} from "@ardurbot/contracts";
import { ACTIVE_RUN_STATUSES, botMessageContext, runNotificationCategory } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { delegationView, getUserPreferences } from "@ardurbot/db";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function activityPromptSnippet(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): string {
  if (input.trigger !== "bot_message") return promptSnippet(input.prompt, max);
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) return "Message from another agent";
  const name = message.fromBotName.trim() || "Another agent";
  const label =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? `Update from ${name}`
      : `${name} asked`;
  return promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max);
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

/** The classified cause a failed run carries, for the activity row's one short reason. */
export function activityRunFailure(row: {
  status: string;
  runtimeProblem?: unknown;
  providerErrorKind?: string | null;
  runtimePin?: unknown;
  error?: string | null;
}): { failureCategory: FailureCategoryId; failureRuntime: string | null } | Record<string, never> {
  if (row.status !== "failed") return {};
  const pin = RuntimePinSchema.safeParse(row.runtimePin);
  const pinRuntime =
    pin.success && pin.data.runtimeKind ? (runtimeNames[pin.data.runtimeKind] ?? null) : null;
  const problem = RuntimeProblemSchema.safeParse(row.runtimeProblem);
  if (problem.success) {
    const category = FailureCategoryIdSchema.safeParse(problem.data.reasonId);
    if (category.success)
      return {
        failureCategory: category.data,
        failureRuntime: runtimeNames[problem.data.pin.runtimeKind] ?? pinRuntime,
      };
  }
  if (row.providerErrorKind === "rate-limit")
    return { failureCategory: "usage-limit", failureRuntime: pinRuntime };
  if (row.providerErrorKind === "auth")
    return { failureCategory: "signed-out", failureRuntime: pinRuntime };
  if (row.providerErrorKind === "model-unavailable")
    return { failureCategory: "model-unavailable", failureRuntime: pinRuntime };
  // Older records hold the English sentence; map it back so the row translates it too.
  const legacy = row.error
    ? failureCategoryFromText(row.error, { runtimes: Object.values(runtimeNames) })
    : undefined;
  if (legacy)
    return { failureCategory: legacy.id, failureRuntime: legacy.params.runtime ?? pinRuntime };
  return {};
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
  scope?: { botId: string; rootTaskIds: string[] },
): Promise<RunActivityRow[]> {
  const preferences = await getUserPreferences(prisma, actor.userId);
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      ...(scope
        ? {
            OR: [
              { botId: scope.botId },
              { delegationRootTaskId: { in: scope.rootTaskIds } },
              { taskId: { in: scope.rootTaskIds } },
            ],
          }
        : {}),
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          externalConversationId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? RECENT_LIMIT : undefined,
  });

  const roots = [...new Set(rows.map((row) => row.delegationRootTaskId ?? row.taskId))];
  const delegations = await prisma.delegation.findMany({
    where: { rootTaskId: { in: roots }, spaceId: actor.spaceId, userId: actor.userId },
    orderBy: { createdAt: "asc" },
  });
  const waitingRoots = rows
    .filter((row) => row.status === "waiting_input" && row.delegationId)
    .map((row) => row.delegationRootTaskId ?? row.taskId);
  const approvalRoots = waitingRoots.length
    ? await prisma.delegationRoot.findMany({
        where: {
          rootTaskId: { in: [...new Set(waitingRoots)] },
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        select: { rootTaskId: true, coordinatorBotId: true, coordinatorThreadId: true },
      })
    : [];
  const approvalThreads = approvalRoots.length
    ? await prisma.thread.findMany({
        where: {
          id: { in: approvalRoots.map((root) => root.coordinatorThreadId) },
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        select: { id: true, groupId: true },
      })
    : [];
  const approvalTargets = new Map(
    approvalRoots.flatMap((root) => {
      const thread = approvalThreads.find((entry) => entry.id === root.coordinatorThreadId);
      return thread
        ? [
            [
              root.rootTaskId,
              {
                botId: root.coordinatorBotId,
                threadId: thread.id,
                groupId: thread.groupId,
              },
            ] as const,
          ]
        : [];
    }),
  );
  const representative = new Map(
    roots.map((root) => [
      root,
      rows.find((row) => row.taskId === root)?.id ??
        rows.find((row) => row.delegationRootTaskId === root)?.id,
    ]),
  );
  return rows.map((row) => ({
    startedAt: row.startedAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString(),
    rootTaskId: row.delegationRootTaskId ?? row.taskId,
    delegations:
      representative.get(row.delegationRootTaskId ?? row.taskId) === row.id
        ? delegations
            .filter((item) => item.rootTaskId === (row.delegationRootTaskId ?? row.taskId))
            .map(delegationView)
        : [],
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group?.name ?? null,
    threadId: row.threadId,
    approvalTarget: row.delegationId
      ? (approvalTargets.get(row.delegationRootTaskId ?? row.taskId) ?? null)
      : null,
    externalThread: Boolean(row.thread.externalConversationId),
    status: row.status as RunActivityRow["status"],
    ...activityRunFailure(row),
    trigger: RunTriggerSchema.parse(row.trigger),
    routineId: row.routineId,
    notificationsEnabled:
      activityNotificationsEnabled(row.thread.groupId, row.bot.notifyOnFinish) &&
      preferences.notifications[
        runNotificationCategory(
          row,
          row.status === "waiting_input" || row.status === "waiting_takeover",
        )
      ],
    promptSnippet: activityPromptSnippet({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}
