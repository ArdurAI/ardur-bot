import { randomUUID } from "node:crypto";
import type {
  EncryptedSecretStore,
  McpOAuthBroker,
  RemoteConnectorDependencies,
} from "@ardurbot/adapters";
import {
  assertSafeRemoteUrl,
  connectableIntegration,
  integrationById,
  integrationCatalog,
  McpConnector,
} from "@ardurbot/adapters";
import type { Actor, IntegrationConnection, IntegrationManifest } from "@ardurbot/contracts";
import { IntegrationManifestSchema, IntegrationStateSchema } from "@ardurbot/contracts";
import type { McpServer, PrismaClient } from "@ardurbot/db";
import { IsolationError, Prisma } from "@ardurbot/db";

type Owner = Pick<Actor, "spaceId" | "userId">;

export function connectionDto(server: McpServer, needsReview = false): IntegrationConnection {
  const manifest = IntegrationManifestSchema.safeParse(server.manifest);
  return {
    id: server.id,
    catalogId: server.catalogId ?? "",
    state: IntegrationStateSchema.parse(server.connectionState),
    manifest: manifest.success ? manifest.data : null,
    needsReview,
  };
}

export function needsClientRegistration(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamic client registration|client (information|registration)|register(ing| registration)? client/i.test(
      error.message,
    )
  );
}

/** Trusted catalog lifecycle. All row lookups are scoped to the signed-in owner and space. */
export class IntegrationConnections {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly oauth: McpOAuthBroker,
    private readonly secrets: EncryptedSecretStore,
    private readonly webOrigin: string,
    private readonly network: RemoteConnectorDependencies = {},
    private readonly stdio: { stdioEnabled?: boolean; allowedCommands?: string[] } = {},
  ) {}

  async list(actor: Owner) {
    const servers = await this.prisma.mcpServer.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, catalogId: { not: null } },
      include: { assignments: true },
      orderBy: { createdAt: "desc" },
    });
    return {
      catalog: [...integrationCatalog],
      connections: servers.map((row) =>
        connectionDto(
          row,
          row.assignments.some((grant) => grant.needsReview),
        ),
      ),
    };
  }

  async owned(actor: Owner, id: string): Promise<McpServer> {
    const server = await this.prisma.mcpServer.findFirst({
      where: { id, spaceId: actor.spaceId, userId: actor.userId },
    });
    if (!server) throw new IsolationError();
    return server;
  }

  async tools(actor: Owner, id: string): Promise<IntegrationManifest> {
    const server = await this.owned(actor, id);
    if (!server.enabled) throw new Error("Connect this integration first.");
    const connector = new McpConnector(
      this.prisma,
      this.secrets,
      { network: this.network, ...this.stdio },
      this.oauth,
    );
    try {
      return await connector.inspectServer(server, {
        operationId: "integrations.discover",
        traceId: "integrations.discover",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: AbortSignal.timeout(30_000),
      });
    } finally {
      await connector.close();
    }
  }

  async connect(actor: Owner, input: { catalogId: string; connectionId?: string; host?: string }) {
    const descriptor = connectableIntegration(input.catalogId, input.host);
    // Uses the existing DNS/IP checks, without a vendor exemption.
    await assertSafeRemoteUrl(descriptor.endpoint!, this.network.resolveHostname);
    let server: McpServer;
    if (input.connectionId) {
      server = await this.owned(actor, input.connectionId);
      if (
        server.catalogId !== descriptor.id ||
        (input.host && server.endpoint !== descriptor.endpoint)
      )
        throw new IsolationError();
      await this.revoke(actor, server.id);
      server = await this.prisma.mcpServer.update({
        where: { id: server.id },
        data: { enabled: true, connectionState: "awaiting-consent" },
      });
    } else {
      const id = randomUUID();
      server = await this.prisma.mcpServer.create({
        data: {
          id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          slug: `catalog-${descriptor.id}-${id.slice(0, 8)}`,
          name: descriptor.name,
          transport: "streamable_http",
          endpoint: descriptor.endpoint,
          catalogId: descriptor.id,
          connectionState: "awaiting-consent",
        },
      });
    }
    try {
      const started = await this.oauth.begin({
        serverId: server.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        redirectUri: new URL("/mcp/oauth/callback", this.webOrigin).toString(),
      });
      if (started.status === "already_connected") {
        await this.capture(actor, server.id);
      } else if (started.status !== "authorization_required") {
        await this.prisma.mcpServer.update({
          where: { id: server.id },
          data: { connectionState: "discovery-failed" },
        });
      }
      return {
        connection: connectionDto(await this.owned(actor, server.id)),
        authorizationUrl:
          started.status === "authorization_required" ? started.authorizationUrl : null,
        sessionId: started.status === "authorization_required" ? started.sessionId : null,
      };
    } catch (error) {
      await this.prisma.mcpServer.updateMany({
        where: { id: server.id, enabled: true, revision: server.revision },
        data: {
          connectionState: needsClientRegistration(error)
            ? "needs-client-registration"
            : "discovery-failed",
        },
      });
      // Provider errors may contain authorization codes or tokens. Return only a state.
      return {
        connection: connectionDto(await this.owned(actor, server.id)),
        authorizationUrl: null,
        sessionId: null,
      };
    }
  }

  async capture(actor: Owner, id: string): Promise<void> {
    const server = await this.owned(actor, id);
    if (!server.catalogId || !server.enabled) return;
    try {
      const manifest = await this.tools(actor, id);
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${id}))`;
        const captured = await tx.mcpServer.updateMany({
          where: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            enabled: true,
            revision: server.revision,
          },
          data: {
            manifest,
            connectionState: "connected",
            spaceAllowedTools: [],
            revision: { increment: 1 },
          },
        });
        if (!captured.count) return;
        // A refreshed manifest never silently inherits grants to an older tool definition.
        await tx.botMcpServer.updateMany({
          where: { serverId: id, spaceId: actor.spaceId, userId: actor.userId },
          data: { allowedTools: [], allowAllTools: false, needsReview: true },
        });
        await this.invalidateApprovals(tx, actor, server);
      });
      await McpConnector.invalidateConnection(id, actor);
    } catch {
      await this.prisma.mcpServer.updateMany({
        where: {
          id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          enabled: true,
          revision: server.revision,
        },
        data: { connectionState: "discovery-failed", manifest: Prisma.DbNull },
      });
    }
  }

  async grants(actor: Owner, id: string) {
    await this.owned(actor, id);
    const rows = await this.prisma.botMcpServer.findMany({
      where: { serverId: id, spaceId: actor.spaceId, userId: actor.userId },
    });
    return rows.map((row) => ({
      botId: row.botId,
      needsReview: row.needsReview || row.allowAllTools,
      toolIds: row.needsReview || row.allowAllTools ? [] : (row.allowedTools as string[]),
    }));
  }

  async assign(actor: Owner, input: { connectionId: string; botIds: string[]; toolIds: string[] }) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.connectionId}))`;
      const server = await tx.mcpServer.findFirst({
        where: {
          id: input.connectionId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          enabled: true,
        },
      });
      if (!server?.catalogId || !integrationById(server.catalogId)?.available)
        throw new IsolationError();
      const manifest = IntegrationManifestSchema.safeParse(server.manifest);
      if (server.connectionState !== "connected" || !manifest.success)
        throw new Error("Connect this integration before choosing tools.");
      const descriptor = integrationById(server.catalogId)!;
      const names = new Set(
        manifest.data.tools
          .filter((tool) => descriptor.toolPolicies[tool.id]?.approval !== "disabled")
          .map((tool) => tool.id),
      );
      if (input.toolIds.some((id) => !names.has(id)))
        throw new Error("Review the available tools and try again.");
      const botIds = [...new Set(input.botIds)];
      const bots = await tx.bot.findMany({
        where: {
          id: { in: botIds },
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (bots.length !== botIds.length) throw new IsolationError();
      const toolIds = [...new Set(input.toolIds)];
      await tx.botMcpServer.deleteMany({
        where: { serverId: server.id, spaceId: actor.spaceId, userId: actor.userId },
      });
      if (botIds.length)
        await tx.botMcpServer.createMany({
          data: botIds.map((botId) => ({
            spaceId: actor.spaceId,
            userId: actor.userId,
            serverId: server.id,
            botId,
            allowAllTools: false,
            needsReview: false,
            allowedTools: toolIds,
          })),
        });
      await tx.mcpServer.update({
        where: { id: server.id },
        data: { spaceAllowedTools: toolIds, revision: { increment: 1 } },
      });
      await this.invalidateApprovals(tx, actor, server);
    });
    return this.grants(actor, input.connectionId);
  }

  async revoke(actor: Owner, id: string, state: "not-connected" | "cancelled" = "not-connected") {
    const server = await this.owned(actor, id);
    if (!server.catalogId) throw new IsolationError();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${id}))`;
      await tx.mcpServer.update({
        where: { id },
        data: {
          enabled: false,
          connectionState: state,
          manifest: Prisma.DbNull,
          spaceAllowedTools: [],
          revision: { increment: 1 },
        },
      });
      await tx.botMcpServer.deleteMany({
        where: { serverId: id, spaceId: actor.spaceId, userId: actor.userId },
      });
      await tx.mcpOAuthSession.deleteMany({
        where: { serverId: id, spaceId: actor.spaceId, userId: actor.userId },
      });
      await this.invalidateApprovals(tx, actor, server);
    });
    await McpConnector.invalidateConnection(id, actor);
    await this.oauth.disconnect({ serverId: id, spaceId: actor.spaceId, userId: actor.userId });
    return { ok: true as const };
  }

  private async invalidateApprovals(tx: Prisma.TransactionClient, actor: Owner, server: McpServer) {
    await tx.externalEffect.updateMany({
      where: {
        spaceId: actor.spaceId,
        run: { userId: actor.userId },
        status: { in: ["intended", "approved"] },
        OR: [
          { kind: { startsWith: `mcp__${server.slug}__` } },
          { request: { path: ["3", "resourceId"], equals: server.id } },
          { request: { path: ["2", "route", "resourceId"], equals: server.id } },
        ],
      },
      data: { status: "denied" },
    });
  }
}
