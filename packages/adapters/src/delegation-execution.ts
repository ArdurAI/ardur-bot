import type { ConnectorRoute } from "@ardurbot/adapter-kit";
import { DelegationAuthoritySchema, TaskCardSchema } from "@ardurbot/contracts";
import {
  classifyRemoteTool,
  parseGroupAskKey,
  peerEffectResourceRef,
  remotePermissionExpansion,
} from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import {
  peerTrafficPaused,
  reconcileGoalExhaustion,
  requestCancel,
  updateWorkerTask,
} from "@ardurbot/db";
import { grantedMcpTools, mcpGrantForBot } from "./integration-access.js";
import { loadPeerBoundEffect } from "./peer-bound-effect.js";
import {
  peerEffectBoundToolAllowed,
  peerReadOnlyRuntimeSupported,
  peerReadOnlyToolAllowed,
} from "./peer-policy.js";

/**
 * The recorded ceiling also applies to connector routes resolved after catalog lookup. A worker
 * that has used its reservation is stopped before its next step; the background stop check
 * passes `reservation: false`, because usage arrives only after a request finishes and a turn
 * that ended over its reservation must keep its answer rather than race to discard it.
 */
export async function checkDelegationExecution(
  prisma: PrismaClient,
  runId: string,
  tool?: string,
  route?: ConnectorRoute,
  helperDelegationId?: string,
  options: { reservation?: boolean } = {},
): Promise<string | undefined> {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (run.goalId) {
    const peerDelegation = run.delegationId
      ? await prisma.delegation.findFirst({
          where: { id: run.delegationId, kind: "message" },
          select: { id: true },
        })
      : null;
    const peerWake = await prisma.botMessageWake.findFirst({
      where: { runId, state: "bound" },
      select: { id: true },
    });
    const peerCoordinatorWake = run.clientNonce?.startsWith("goal-wake:")
      ? await prisma.delegation.findFirst({
          where: { id: run.clientNonce.slice("goal-wake:".length), kind: "message" },
          select: { id: true },
        })
      : null;
    if (peerDelegation || peerWake || peerCoordinatorWake) {
      const goal = await prisma.teamGoal.findUnique({
        where: { id: run.goalId },
        select: { groupId: true },
      });
      if (
        !goal ||
        (await peerTrafficPaused(prisma, {
          spaceId: run.spaceId,
          userId: run.userId,
          groupId: goal.groupId,
        }))
      ) {
        await prisma.run.updateMany({
          where: { id: runId, cancelRequestedAt: null },
          data: { cancelRequestedAt: new Date() },
        });
        return "Team messages are paused.";
      }
    }
  }
  const rootTaskId = run.delegationRootTaskId ?? run.taskId;
  const root = await prisma.delegationRoot.findUnique({ where: { rootTaskId } });
  // Outside a goal, spending past the task's token budget refuses new workers at admission but
  // never takes back reservations already admitted. A native coordinator reports its whole
  // turn's usage as the turn ends, just before its room workers can start. A goal's budget
  // stays the owner's cap for the whole tree.
  if (
    root &&
    (root.cancelRequestedAt ||
      root.deadlineAt <= new Date() ||
      (run.goalId && root.usedTokens >= root.tokenLimit))
  ) {
    if (!root.cancelRequestedAt)
      await requestCancel(prisma, { spaceId: run.spaceId, userId: run.userId }, rootTaskId);
    if (run.goalId) await reconcileGoalExhaustion(prisma, run.goalId);
    return "This task is stopping; start a new task to continue.";
  }
  const delegationId = helperDelegationId ?? run.delegationId;
  if (!delegationId) return;
  const row = await prisma.delegation.findUniqueOrThrow({ where: { id: delegationId } });
  // A member asked by its room coordinator stops when the owner pauses team messages there.
  if (parseGroupAskKey(row.admissionKey)) {
    const thread = await prisma.thread.findUnique({
      where: { id: run.threadId },
      select: { groupId: true },
    });
    if (
      thread?.groupId &&
      (await peerTrafficPaused(prisma, {
        spaceId: run.spaceId,
        userId: run.userId,
        groupId: thread.groupId,
      }))
    ) {
      await prisma.run.updateMany({
        where: { id: run.id, cancelRequestedAt: null },
        data: { cancelRequestedAt: new Date() },
      });
      return "Team messages are paused.";
    }
  }
  const card = TaskCardSchema.safeParse(row.card);
  if (
    card.success &&
    (card.data.peerMode === "read-only" || card.data.peerMode === "effect-bound")
  ) {
    if (
      !peerReadOnlyRuntimeSupported(
        String((run.runtimePin as { runtimeKind?: string } | null)?.runtimeKind ?? ""),
      )
    )
      return "This connection cannot run this peer task safely.";
    // An effect-bound card admits exactly the approved tool on the approved
    // connector route. Anything else is refused and recorded, as for read-only.
    const bound =
      card.data.peerMode === "effect-bound"
        ? ((await loadPeerBoundEffect(prisma, runId)) ?? undefined)
        : undefined;
    const boundRouteAllowed = Boolean(
      bound &&
        tool === bound.effect.toolName &&
        route &&
        route.connectorId !== "builtin" &&
        peerEffectResourceRef(route) === bound.effect.resourceRef,
    );
    if (
      (tool && !peerEffectBoundToolAllowed(tool, bound?.effect)) ||
      (route && route.connectorId !== "builtin" && !boundRouteAllowed)
    ) {
      await prisma.$transaction((tx) =>
        updateWorkerTask(tx, {
          runId: run.id,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          executionId: `peer-block:${run.id}`,
          tool: "report_progress",
          args: {
            state: "blocked",
            text: "This desk request needs an action outside its approved card.",
            action: "Bring the request to the owner for review.",
          },
        }),
      );
      return "This peer task is read-only. Ask the coordinator to bring blocked work to the owner.";
    }
  }
  if (helperDelegationId && (row.kind !== "helper" || row.parentRunId !== runId))
    return "This helper does not belong to this run.";
  if (
    !["queued", "running"].includes(row.status) ||
    row.deadlineAt <= new Date() ||
    (options.reservation !== false && row.usedTokens >= row.reservedTokens)
  ) {
    if (!helperDelegationId)
      await prisma.run.updateMany({
        where: { id: run.id, cancelRequestedAt: null },
        data: { cancelRequestedAt: new Date() },
      });
    return "This worker has reached its budget or is stopping.";
  }
  if (!tool) return;
  const authority = DelegationAuthoritySchema.parse(row.authority);
  const policies = await prisma.remoteAuthorityPolicy.findMany({
    where: {
      OR: [
        { layer: "space", subjectId: run.spaceId },
        { layer: "bot", subjectId: row.requesterBotId },
        { layer: "bot", subjectId: row.actingBotId },
      ],
    },
  });
  const category = classifyRemoteTool(tool);
  if (
    remotePermissionExpansion(tool) ||
    !authority.scopes.includes(category) ||
    policies.some((policy) => !policy.scopes.includes(category))
  )
    return "This tool exceeds the requester's permission; ask the owner to review access.";
  if (
    route &&
    route.connectorId !== "builtin" &&
    (!route.resourceId ||
      !authority.connectors.includes(`${route.connectorId}:${route.resourceId}`))
  )
    return "This connector is outside the requester's grant; ask the owner to review access.";
  if (route?.connectorId === "mcp" && route.resourceId) {
    const assignment = await mcpGrantForBot(
      prisma,
      {
        botId: row.requesterBotId,
        spaceId: run.spaceId,
        userId: run.userId,
      },
      route.resourceId,
    );
    if (
      !authority.connectors.includes(`mcp:${route.resourceId}:${route.toolName}`) ||
      !assignment ||
      !grantedMcpTools(assignment, [route.toolName]).length
    )
      return "This tool is outside the requester's connector grant; ask the owner to review access.";
  }
}
