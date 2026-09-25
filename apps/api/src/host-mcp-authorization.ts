import { grantedMcpTools, integrationResourceDenial } from "@ardurbot/adapters";
import { IntegrationManifestSchema } from "@ardurbot/contracts";
import type { HostRequest } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";

export async function authorizeHostMcp(
  prisma: PrismaClient,
  request: HostRequest,
  settingsRequest: boolean,
) {
  const operation = request.operation;
  if (!("serverId" in operation)) return false;
  const server = await prisma.mcpServer.findFirst({
    where: {
      id: operation.serverId,
      spaceId: request.scope.spaceId,
      userId: request.scope.userId,
      placement: "host",
      transport: "stdio",
      revision: operation.revision,
    },
  });
  if (!server) return false;
  if (settingsRequest)
    return (
      operation.op === "mcp.status" ||
      operation.op === "mcp.stop" ||
      (operation.op === "mcp.tools" && server.enabled)
    );
  if (!server.enabled || !["mcp.call", "mcp.tools"].includes(operation.op)) return false;
  const run = await prisma.run.findFirst({
    where: {
      id: request.scope.runId,
      botId: request.scope.botId,
      spaceId: request.scope.spaceId,
      userId: request.scope.userId,
      status: "running",
      cancelRequestedAt: null,
    },
  });
  if (!run) return false;
  const assignment = await prisma.botMcpServer.findFirst({
    where: {
      botId: request.scope.botId,
      serverId: server.id,
      spaceId: request.scope.spaceId,
      userId: request.scope.userId,
    },
  });
  if (!assignment || assignment.needsReview || assignment.allowAllTools) return false;
  if (operation.op === "mcp.tools") return true;
  if (
    operation.op !== "mcp.call" ||
    !grantedMcpTools({ ...assignment, server }, [operation.name]).includes(operation.name)
  )
    return false;
  const manifest = IntegrationManifestSchema.safeParse(server.manifest);
  const tool = manifest.data?.tools.find((entry) => entry.id === operation.name);
  return !integrationResourceDenial(
    server,
    tool ?? { id: operation.name, description: "" },
    operation.args,
  );
}
