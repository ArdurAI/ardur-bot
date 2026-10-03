import type { AdapterContext, ConnectorRoute, SandboxProvider } from "@ardurbot/adapter-kit";
import {
  computerRunsOnHost,
  IntegrationManifestSchema,
  IntegrationResourceConstraintsSchema,
  notionResourceId,
  SpaceToolPoliciesSchema,
} from "@ardurbot/contracts";
import type { IntegrationApproval } from "@ardurbot/core";
import { approvalFor, effectiveMcpGrantTools, integrationToolKind } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import type { IntegrationApprovalAction } from "./approval-ask.js";
import { prepareHostCommandApproval } from "./host-integration-tools.js";
import { integrationById } from "./integration-catalog.js";
import { oauthMaterialSecrets } from "./mcp-oauth.js";
import type { EncryptedSecretStore } from "./secrets.js";

export function stringTools(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export type McpGrant = {
  access?: string;
  allowAllTools: boolean;
  needsReview?: boolean;
  allowedTools: unknown;
  server: {
    enabled: boolean;
    catalogId?: string | null;
    connectionState?: string;
    manifest?: unknown;
    spaceAllowedTools?: unknown;
    needsReview?: boolean;
    spaceToolPolicies?: unknown;
    resourceConstraints?: unknown;
  };
};

export function grantedMcpTools(assignment: McpGrant, offered: readonly string[]): string[] {
  if (
    !assignment.server.enabled ||
    assignment.server.needsReview ||
    assignment.needsReview ||
    assignment.allowAllTools ||
    assignment.access === "none" ||
    (assignment.access !== undefined && !["custom", "inherit"].includes(assignment.access))
  )
    return [];
  const space = stringTools(assignment.server.spaceAllowedTools);
  const bot = stringTools(assignment.allowedTools);
  if (!assignment.server.catalogId)
    return effectiveMcpGrantTools(
      offered,
      space,
      bot,
      assignment.access,
      Boolean(assignment.server.manifest),
    );
  const descriptor = integrationById(assignment.server.catalogId);
  const manifest = IntegrationManifestSchema.safeParse(assignment.server.manifest);
  if (
    !descriptor?.available ||
    assignment.server.connectionState !== "connected" ||
    !manifest.success
  )
    return [];
  const captured = new Set(manifest.data.tools.map((tool) => tool.id));
  return effectiveMcpGrantTools(offered, space, bot, assignment.access, true).filter(
    (id) => captured.has(id) && descriptor.toolPolicies[id]?.approval !== "disabled",
  );
}

export async function mcpGrantForBot(
  prisma: PrismaClient,
  context: Pick<AdapterContext, "spaceId" | "userId" | "botId">,
  serverId: string,
) {
  if (!context.botId) return null;
  const assignment = await prisma.botMcpServer.findFirst({
    where: {
      botId: context.botId,
      serverId,
      spaceId: context.spaceId,
      userId: context.userId,
      server: { enabled: true },
    },
    include: { server: true },
  });
  if (assignment && assignment.server.transport !== "host-cli") return assignment;
  const bot = await prisma.bot.findFirst({
    where: {
      id: context.botId,
      spaceId: context.spaceId,
      userId: context.userId,
      archivedAt: null,
    },
    select: { id: true, computer: { select: { kind: true, connectionId: true } } },
  });
  if (!bot || (assignment?.server.transport === "host-cli" && !computerRunsOnHost(bot.computer)))
    return null;
  if (assignment) return assignment;
  const server = await prisma.mcpServer.findFirst({
    where: { id: serverId, spaceId: context.spaceId, userId: context.userId, enabled: true },
  });
  if (!server || (server.transport === "host-cli" && !computerRunsOnHost(bot.computer)))
    return null;
  return {
    id: null,
    serverId,
    access: "inherit",
    allowAllTools: false,
    needsReview: false,
    allowedTools: server.spaceAllowedTools,
    server,
  };
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
  secretStore?: EncryptedSecretStore,
  sandbox?: SandboxProvider,
): Promise<
  | {
      approval: IntegrationApproval;
      integration?: IntegrationApprovalAction;
      secrets?: string[];
      denial?: string;
    }
  | undefined
> {
  if (route?.connectorId !== "mcp" || !route.resourceId) return undefined;
  if (!context.botId) return { approval: "disabled" };
  const assignment = await mcpGrantForBot(prisma, context, route.resourceId);
  if (!assignment || !grantedMcpTools(assignment, [route.toolName]).length)
    return { approval: "disabled" };
  if (!assignment.server.catalogId && !assignment.server.manifest) return undefined;
  if (route.resourceRevision !== assignment.server.revision) return { approval: "disabled" };
  const descriptor = assignment.server.catalogId
    ? integrationById(assignment.server.catalogId)
    : {
        name: assignment.server.name,
        available: true,
        toolPolicies: {},
      };
  const manifest = IntegrationManifestSchema.safeParse(assignment.server.manifest);
  if (!descriptor || !manifest.success) return { approval: "disabled" };
  const tool = manifest.data.tools.find((tool) => tool.id === route.toolName);
  if (!tool) return { approval: "disabled" };
  const denial = integrationResourceDenial(assignment.server, tool, args);
  if (denial) return { approval: "disabled", denial };
  let secrets: string[] = [];
  if (secretStore && assignment.server.secretId) {
    const row = await prisma.secret.findFirst({
      where: { id: assignment.server.secretId, spaceId: context.spaceId, userId: context.userId },
    });
    if (!row) return { approval: "disabled" };
    secrets = oauthMaterialSecrets(JSON.parse(secretStore.load(row.ciphertext, row.id)));
  }
  const policies = SpaceToolPoliciesSchema.safeParse(assignment.server.spaceToolPolicies);
  return {
    secrets,
    approval: approvalFor(descriptor, tool.id, args, tool.description, policies.data ?? {}),
    integration: {
      vendorName: descriptor.name,
      toolId: tool.id,
      description: tool.description,
      ...(assignment.server.transport === "host-cli" && tool.id === "execute_command"
        ? { hostCommandRequired: true }
        : {}),
      ...(assignment.server.transport === "host-cli" && tool.id === "execute_command" && sandbox
        ? {
            hostCommand: (
              await prepareHostCommandApproval(
                prisma,
                sandbox,
                assignment.server,
                args,
                context as AdapterContext,
              )
            ).approval,
          }
        : {}),
    },
  };
}

/** Resource identity must be provable from the request; missing or opaque targets fail closed. */
export function integrationResourceDenial(
  server: { catalogId?: string | null; resourceConstraints?: unknown },
  tool: { id: string; description: string },
  args: Record<string, unknown>,
): string | undefined {
  if (server.catalogId !== "notion" && server.catalogId !== "atlassian") return;
  const read =
    integrationToolKind(tool.id, tool.description) === "read" &&
    !Object.entries(args).some(
      ([key, value]) =>
        /^(action|operation|method|command)$/i.test(key) &&
        (typeof value !== "string" || !/^(get|list|search|find|read|fetch)$/i.test(value)),
    );
  if (server.catalogId === "notion" && read) return;
  const parsed = IntegrationResourceConstraintsSchema.safeParse(server.resourceConstraints);
  const constraints = parsed.success ? parsed.data : {};
  const denial =
    server.catalogId === "notion"
      ? "Choose the allowed Notion destination before writing here."
      : "This project or space is outside the allowed destinations.";
  let targets = 0;
  let invalid = false;
  function check(value: unknown, allowed: string[], notion = false) {
    targets++;
    const normalized =
      typeof value === "string" ? (notion ? notionResourceId(value) : value) : undefined;
    if (!normalized || !allowed.includes(normalized)) invalid = true;
  }
  function walk(value: unknown, depth = 0) {
    if (depth > 12) {
      invalid = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [raw, item] of Object.entries(value)) {
      const key = raw.replaceAll("_", "").toLowerCase();
      if (server.catalogId === "notion") {
        if (
          /^(parent|parentid|pageid|databaseid|blockid|id|sourcepageid|targetpageid|destinationid)$/.test(
            key,
          )
        ) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            walk(item, depth + 1);
          } else check(item, constraints.notion ? [constraints.notion.parentId] : [], true);
        } else if (/id$|ids$|url|target|destination|parent|source|query/i.test(key)) {
          invalid = true;
        } else if (typeof item === "object") walk(item, depth + 1);
      } else {
        if (/^(project|projectkey|projectid|projectidorkey)$/.test(key)) {
          const target =
            item && typeof item === "object"
              ? ((item as Record<string, unknown>).key ?? (item as Record<string, unknown>).id)
              : item;
          check(target, constraints.jiraProjects ?? []);
        } else if (/^(space|spacekey|spaceid)$/.test(key)) {
          const target =
            item && typeof item === "object"
              ? ((item as Record<string, unknown>).key ?? (item as Record<string, unknown>).id)
              : item;
          check(target, constraints.confluenceSpaces ?? []);
        } else if (/^(issuekey|issueidorkey)$/.test(key)) {
          const match =
            typeof item === "string" ? item.match(/^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/) : null;
          check(match?.[1], constraints.jiraProjects ?? []);
        } else if (/^(jql|cql)$/.test(key)) {
          // Arbitrary query expressions (especially OR/NOT) cannot establish a resource boundary.
          const match =
            typeof item === "string"
              ? item.match(
                  /^\s*(project|space)\s*=\s*(?:"([A-Za-z0-9_~-]+)"|([A-Za-z0-9_~-]+))\s*$/i,
                )
              : null;
          check(
            match?.[2] ?? match?.[3],
            match?.[1]?.toLowerCase() === "project"
              ? (constraints.jiraProjects ?? [])
              : (constraints.confluenceSpaces ?? []),
          );
        } else if (/^(id|issueid|pageid|contentid|parentid|destinationid)$/.test(key)) {
          // A caller-supplied project/space next to an opaque ID is not proof of its ownership.
          invalid = true;
        } else if (
          key !== "cloudid" &&
          /id$|ids$|key$|keys$|url|target|destination|parent|source|query|project|space|issue/i.test(
            key,
          )
        ) {
          invalid = true;
        } else if (typeof item === "object") walk(item, depth + 1);
      }
    }
  }
  walk(args);
  return invalid || !targets ? denial : undefined;
}

export const MCP_TOOLS_NEED_REVIEW_SENTENCE =
  "Connected integration tools exist but need review in Settings → Integrations before this bot can use them.";

export function mcpToolsPendingReview(assignment: McpGrant): boolean {
  const manifest = IntegrationManifestSchema.safeParse(assignment.server.manifest);
  return (
    assignment.server.enabled &&
    assignment.server.connectionState === "connected" &&
    assignment.access !== "none" &&
    manifest.success &&
    manifest.data.tools.length > 0 &&
    grantedMcpTools(
      assignment,
      manifest.data.tools.map((tool) => tool.id),
    ).length === 0
  );
}

/** Report only the acting bot's scoped connections; never reveal another space's tools. */
export async function mcpReviewDiscoveryLine(
  prisma: PrismaClient,
  context: Pick<AdapterContext, "spaceId" | "userId" | "botId">,
): Promise<string | undefined> {
  if (!context.botId) return undefined;
  const bot = await prisma.bot.findFirst({
    where: {
      id: context.botId,
      spaceId: context.spaceId,
      userId: context.userId,
      archivedAt: null,
    },
    select: { id: true, computer: { select: { kind: true, connectionId: true } } },
  });
  if (!bot) return undefined;
  const servers = await prisma.mcpServer.findMany({
    where: {
      spaceId: context.spaceId,
      userId: context.userId,
      enabled: true,
      connectionState: "connected",
    },
    include: {
      assignments: {
        where: { botId: context.botId, spaceId: context.spaceId, userId: context.userId },
      },
    },
  });
  const pending = servers.some(
    (server) =>
      (server.transport !== "host-cli" || computerRunsOnHost(bot.computer)) &&
      mcpToolsPendingReview({
        ...(server.assignments[0] ?? {
          access: "inherit",
          allowAllTools: false,
          needsReview: false,
          allowedTools: server.spaceAllowedTools,
        }),
        server,
      }),
  );
  return pending
    ? `Tool discovery: ${MCP_TOOLS_NEED_REVIEW_SENTENCE.slice(0, -1)}; tell the person this sentence when they ask to use unavailable integration tools.`
    : undefined;
}
