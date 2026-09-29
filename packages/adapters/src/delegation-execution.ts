import type { ConnectorRoute } from "@ardurbot/adapter-kit";
import type { DelegationStopReason } from "@ardurbot/contracts";
import { DelegationAuthoritySchema, delegationStopLine, TaskCardSchema } from "@ardurbot/contracts";
import { classifyRemoteTool, remotePermissionExpansion } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import {
  delegationStopReason,
  peerTrafficPaused,
  reconcileGoalExhaustion,
  requestCancel,
  updateWorkerTask,
} from "@ardurbot/db";
import { grantedMcpTools, mcpGrantForBot } from "./integration-access.js";
import { peerReadOnlyRuntimeSupported, peerReadOnlyToolAllowed } from "./peer-policy.js";

/** The recorded ceiling also applies to connector routes resolved after catalog lookup. */
export async function checkDelegationExecution(
  prisma: PrismaClient,
  runId: string,
  tool?: string,
  route?: ConnectorRoute,
  helperDelegationId?: string,
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
  if (
    root &&
    (root.cancelRequestedAt || root.deadlineAt <= new Date() || root.usedTokens >= root.tokenLimit)
  ) {
    if (!root.cancelRequestedAt) {
      // The task itself is stopping. Record deadline or budget now; a later flush of
      // usage must not replace that cause with a different inference.
      const reason: DelegationStopReason =
        root.deadlineAt <= new Date()
          ? "deadline"
          : root.usedTokens >= root.tokenLimit
            ? "budget"
            : "stopped";
      await requestCancel(
        prisma,
        { spaceId: run.spaceId, userId: run.userId },
        rootTaskId,
        new Date(),
        reason,
      );
    }
    if (run.goalId) await reconcileGoalExhaustion(prisma, run.goalId);
    return "This task is stopping; start a new task to continue.";
  }
  const delegationId = helperDelegationId ?? run.delegationId;
  if (!delegationId) return;
  const row = await prisma.delegation.findUniqueOrThrow({ where: { id: delegationId } });
  const card = TaskCardSchema.safeParse(row.card);
  if (card.success && card.data.peerMode === "read-only") {
    if (
      !peerReadOnlyRuntimeSupported(
        String((run.runtimePin as { runtimeKind?: string } | null)?.runtimeKind ?? ""),
      )
    )
      return "This connection cannot run this peer task safely.";
    if ((tool && !peerReadOnlyToolAllowed(tool)) || (route && route.connectorId !== "builtin")) {
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
            text: "This desk request needs an action outside its read-only card.",
            action: "Bring the request to the owner for review.",
          },
        }),
      );
      return "This peer task is read-only. Ask the coordinator to bring blocked work to the owner.";
    }
  }
  if (helperDelegationId && (row.kind !== "helper" || row.parentRunId !== runId))
    return "This helper does not belong to this run.";
  const stopReason: DelegationStopReason | null = !["queued", "running"].includes(row.status)
    ? "stopped"
    : row.deadlineAt <= new Date() || row.usedTokens >= row.reservedTokens
      ? delegationStopReason(row)
      : null;
  if (stopReason) {
    if (stopReason !== "stopped")
      // The gate initiated this stop: record the cause now. Confirmation must not
      // re-infer it from whatever usage or deadline the row shows after unwinding.
      await prisma.delegation.updateMany({
        where: { id: row.id, cancelReason: null },
        data: { cancelReason: stopReason },
      });
    if (!helperDelegationId)
      await prisma.run.updateMany({
        where: { id: run.id, cancelRequestedAt: null },
        data: { cancelRequestedAt: new Date() },
      });
    return stopReason === "stopped"
      ? "This worker is stopping."
      : delegationStopLine(stopReason, "This worker");
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
