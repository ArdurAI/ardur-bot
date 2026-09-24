import type { ConnectorRoute } from "@ardurbot/adapter-kit";
import { DelegationAuthoritySchema } from "@ardurbot/contracts";
import { classifyRemoteTool, remotePermissionExpansion } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { requestCancel } from "@ardurbot/db";
import { grantedMcpTools } from "./integration-access.js";

/** The recorded ceiling also applies to connector routes resolved after catalog lookup. */
export async function checkDelegationExecution(
  prisma: PrismaClient,
  runId: string,
  tool?: string,
  route?: ConnectorRoute,
  helperDelegationId?: string,
): Promise<string | undefined> {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const rootTaskId = run.delegationRootTaskId ?? run.taskId;
  const root = await prisma.delegationRoot.findUnique({ where: { rootTaskId } });
  if (
    root &&
    (root.cancelRequestedAt || root.deadlineAt <= new Date() || root.usedTokens >= root.tokenLimit)
  ) {
    if (!root.cancelRequestedAt)
      await requestCancel(prisma, { spaceId: run.spaceId, userId: run.userId }, rootTaskId);
    return "This task is stopping; start a new task to continue.";
  }
  const delegationId = helperDelegationId ?? run.delegationId;
  if (!delegationId) return;
  const row = await prisma.delegation.findUniqueOrThrow({ where: { id: delegationId } });
  if (helperDelegationId && (row.kind !== "helper" || row.parentRunId !== runId))
    return "This helper does not belong to this run.";
  if (
    row.status === "cancel-requested" ||
    row.deadlineAt <= new Date() ||
    row.usedTokens >= row.reservedTokens
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
    const assignment = await prisma.botMcpServer.findFirst({
      where: {
        botId: row.requesterBotId,
        serverId: route.resourceId,
        spaceId: run.spaceId,
        userId: run.userId,
      },
      include: { server: true },
    });
    if (
      !authority.connectors.includes(`mcp:${route.resourceId}:${route.toolName}`) ||
      !assignment ||
      !grantedMcpTools(assignment, [route.toolName]).length
    )
      return "This tool is outside the requester's connector grant; ask the owner to review access.";
  }
}
