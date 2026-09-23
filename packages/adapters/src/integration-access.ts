import type { AdapterContext, ConnectorRoute } from "@ardurbot/adapter-kit";
import { IntegrationManifestSchema, SpaceToolPoliciesSchema } from "@ardurbot/contracts";
import type { IntegrationApproval } from "@ardurbot/core";
import { approvalFor, effectiveTools } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import type { IntegrationApprovalAction } from "./approval-ask.js";
import { integrationById } from "./integration-catalog.js";

export function stringTools(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export type McpGrant = {
  allowAllTools: boolean;
  needsReview?: boolean;
  allowedTools: unknown;
  server: {
    enabled: boolean;
    catalogId?: string | null;
    connectionState?: string;
    manifest?: unknown;
    spaceAllowedTools?: unknown;
    spaceToolPolicies?: unknown;
  };
};

export function grantedMcpTools(assignment: McpGrant, offered: readonly string[]): string[] {
  if (!assignment.server.enabled || assignment.needsReview || assignment.allowAllTools) return [];
  const bot = stringTools(assignment.allowedTools);
  if (!assignment.server.catalogId) return effectiveTools(offered, bot, bot);
  const descriptor = integrationById(assignment.server.catalogId);
  const manifest = IntegrationManifestSchema.safeParse(assignment.server.manifest);
  if (
    !descriptor?.available ||
    assignment.server.connectionState !== "connected" ||
    !manifest.success
  )
    return [];
  const captured = new Set(manifest.data.tools.map((tool) => tool.id));
  return effectiveTools(offered, stringTools(assignment.server.spaceAllowedTools), bot).filter(
    (id) => captured.has(id) && descriptor.toolPolicies[id]?.approval !== "disabled",
  );
}

/** Fresh DB state is authoritative, including during an approved replay or nested execution. */
export async function integrationApprovalForCall(
  prisma: PrismaClient,
  route: ConnectorRoute | undefined,
  context: Pick<AdapterContext, "spaceId" | "userId" | "botId">,
  args: Record<string, unknown>,
): Promise<IntegrationApproval | undefined> {
  return (await integrationApprovalDetailsForCall(prisma, route, context, args))?.approval;
}

/** Keep the display metadata and policy bound to the same authorized connection snapshot. */
export async function integrationApprovalDetailsForCall(
  prisma: PrismaClient,
  route: ConnectorRoute | undefined,
  context: Pick<AdapterContext, "spaceId" | "userId" | "botId">,
  args: Record<string, unknown>,
): Promise<{ approval: IntegrationApproval; integration?: IntegrationApprovalAction } | undefined> {
  if (route?.connectorId !== "mcp" || !route.resourceId) return undefined;
  if (!context.botId) return { approval: "disabled" };
  const assignment = await prisma.botMcpServer.findFirst({
    where: {
      botId: context.botId,
      serverId: route.resourceId,
      spaceId: context.spaceId,
      userId: context.userId,
      server: { enabled: true },
    },
    include: { server: true },
  });
  if (!assignment || !grantedMcpTools(assignment, [route.toolName]).length)
    return { approval: "disabled" };
  if (!assignment.server.catalogId) return undefined;
  if (route.resourceRevision !== assignment.server.revision) return { approval: "disabled" };
  const descriptor = integrationById(assignment.server.catalogId);
  const manifest = IntegrationManifestSchema.safeParse(assignment.server.manifest);
  if (!descriptor || !manifest.success) return { approval: "disabled" };
  const tool = manifest.data.tools.find((tool) => tool.id === route.toolName);
  if (!tool) return { approval: "disabled" };
  const policies = SpaceToolPoliciesSchema.safeParse(assignment.server.spaceToolPolicies);
  return {
    approval: approvalFor(descriptor, tool.id, args, tool.description, policies.data ?? {}),
    integration: { vendorName: descriptor.name, toolId: tool.id, description: tool.description },
  };
}
