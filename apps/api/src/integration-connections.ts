import { randomUUID } from "node:crypto";
import type {
  EncryptedSecretStore,
  McpHostClient,
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
import type {
  Actor,
  IntegrationConnection,
  IntegrationManifest,
  IntegrationResourceConstraints,
  IntegrationResourceKind,
  SpaceToolPolicies,
} from "@ardurbot/contracts";
import {
  IntegrationManifestSchema,
  IntegrationResourceConstraintsSchema,
  IntegrationStateSchema,
  SpaceToolPoliciesSchema,
} from "@ardurbot/contracts";
import { integrationToolKind } from "@ardurbot/core";
import type { McpServer, PrismaClient } from "@ardurbot/db";
import { IsolationError, Prisma } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

type Owner = Pick<Actor, "spaceId" | "userId">;

export function connectionDto(server: McpServer, needsReview = false): IntegrationConnection {
  const manifest = IntegrationManifestSchema.safeParse(server.manifest);
  return {
    id: server.id,
    catalogId: server.catalogId ?? "",
    state: IntegrationStateSchema.parse(server.connectionState),
    manifest: manifest.success ? manifest.data : null,
    needsReview,
    resourceConstraints:
      IntegrationResourceConstraintsSchema.safeParse(server.resourceConstraints).data ?? {},
    spaceToolPolicies: SpaceToolPoliciesSchema.safeParse(server.spaceToolPolicies).data ?? {},
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
    private readonly stdio: {
      stdioEnabled?: boolean;
      allowedCommands?: string[];
      hostMcp?: McpHostClient;
    } = {},
  ) {}

  async list(actor: Owner) {
    const servers = await this.prisma.mcpServer.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, catalogId: { not: null } },
      include: { assignments: true },
      orderBy: { createdAt: "desc" },
    });
    return {
      webUrl: new URL("/", this.webOrigin).toString(),
      catalog: integrationCatalog.map((descriptor) => ({
        ...descriptor,
        oauthAvailable: Boolean(this.oauthApp(descriptor.id)),
      })),
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

  async beginAuthorization(actor: Owner, input: { serverId: string; redirectUri: string }) {
    await this.owned(actor, input.serverId);
    const started = await this.oauth.begin({
      ...input,
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    if (started.status !== "authorization_required") await this.capture(actor, input.serverId);
    return started;
  }

  private oauthApp(catalogId: string) {
    const app = integrationById(catalogId)?.oauthApp;
    const clientId = app && process.env[app.clientIdEnv]?.trim();
    const clientSecret = app && process.env[app.clientSecretEnv]?.trim();
    return clientId && clientSecret
      ? {
          client_id: clientId,
          client_secret: clientSecret,
          token_endpoint_auth_method: "client_secret_post" as const,
        }
      : undefined;
  }

  async connect(
    actor: Owner,
    input: {
      catalogId: string;
      connectionId?: string;
      host?: string;
      token?: string;
      authKind?: "oauth" | "token";
    },
  ) {
    actor = { spaceId: actor.spaceId, userId: actor.userId };
    const descriptor = connectableIntegration(input.catalogId, input.host);
    const authKind = input.authKind ?? descriptor.authKind;
    const oauthApp = this.oauthApp(descriptor.id);
    if (
      authKind === "token" &&
      (descriptor.authKind !== "token" ||
        !input.token ||
        input.token.length > 16_384 ||
        /\s/.test(input.token))
    )
      throw new ORPCError("BAD_REQUEST", { message: "Enter a valid token." });
    if (authKind === "oauth" && (input.token || (descriptor.authKind === "token" && !oauthApp)))
      throw new ORPCError("BAD_REQUEST", {
        message: "Sign-in is not configured for this integration.",
      });
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
      if (authKind === "token") {
        const stored = await this.secrets.put(JSON.stringify({ secret: input.token }), {
          operationId: "integrations.connect",
          traceId: "integrations.connect",
          ...actor,
          signal: AbortSignal.timeout(30_000),
        });
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${server.id}))`;
          const current = await tx.mcpServer.findFirst({
            where: { id: server.id, ...actor, enabled: true, revision: server.revision },
          });
          if (!current) throw new IsolationError();
          await tx.secret.create({ data: { ...stored, ...actor, kind: "mcp" } });
          await tx.mcpServer.update({ where: { id: server.id }, data: { secretId: stored.id } });
        });
        await this.capture(actor, server.id);
        return {
          connection: connectionDto(await this.owned(actor, server.id)),
          authorizationUrl: null,
          sessionId: null,
        };
      }
      const started = await this.oauth.begin({
        serverId: server.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        redirectUri: new URL("/mcp/oauth/callback", this.webOrigin).toString(),
        ...(oauthApp ? { clientInformation: oauthApp } : {}),
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
    if (!server.enabled) return;
    if (!server.catalogId) {
      try {
        const manifest = await this.tools(actor, id);
        await this.prisma.mcpServer.updateMany({
          where: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            enabled: true,
            revision: server.revision,
          },
          data: { manifest, connectionState: "connected" },
        });
      } catch {
        await this.prisma.mcpServer.updateMany({
          where: { id, spaceId: actor.spaceId, userId: actor.userId, revision: server.revision },
          data: { connectionState: "discovery-failed" },
        });
        throw new Error("Could not connect this server. Check its configuration and try again.");
      }
      return;
    }
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
            spaceToolPolicies: {},
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

  async assign(
    actor: Owner,
    input: {
      connectionId: string;
      botIds: string[];
      toolIds: string[];
      spaceToolPolicies?: SpaceToolPolicies;
      resourceConstraints?: IntegrationResourceConstraints;
    },
  ) {
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
      const constraints =
        input.resourceConstraints === undefined
          ? undefined
          : IntegrationResourceConstraintsSchema.parse(input.resourceConstraints);
      if (
        constraints &&
        ((constraints.notion && server.catalogId !== "notion") ||
          ((constraints.jiraProjects || constraints.confluenceSpaces) &&
            server.catalogId !== "atlassian"))
      )
        throw new ORPCError("BAD_REQUEST", {
          message: "Choose destinations for this integration.",
        });
      const names = new Set(
        manifest.data.tools
          .filter((tool) => descriptor.toolPolicies[tool.id]?.approval !== "disabled")
          .map((tool) => tool.id),
      );
      if (input.toolIds.some((id) => !names.has(id)))
        throw new Error("Review the available tools and try again.");
      let spaceToolPolicies: SpaceToolPolicies | undefined;
      if (input.spaceToolPolicies !== undefined) {
        const member = await tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        });
        if (member?.role !== "owner")
          throw new ORPCError("FORBIDDEN", {
            message: "Only the space owner can change read approvals.",
          });
        const parsed = SpaceToolPoliciesSchema.safeParse(input.spaceToolPolicies);
        if (!parsed.success)
          throw new ORPCError("BAD_REQUEST", {
            message: "Review the tool policies and try again.",
          });
        spaceToolPolicies = parsed.data;
        const tools = new Map(manifest.data.tools.map((tool) => [tool.id, tool]));
        for (const [id, approval] of Object.entries(spaceToolPolicies)) {
          const tool = tools.get(id);
          if (!tool || !names.has(id))
            throw new ORPCError("BAD_REQUEST", {
              message: "Review the available tools and try again.",
            });
          if (approval === "allow" && integrationToolKind(tool.id, tool.description) !== "read")
            throw new ORPCError("BAD_REQUEST", {
              message: "Writes always ask. Only read tools can be allowed without asking.",
            });
        }
      }
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
        data: {
          spaceAllowedTools: toolIds,
          ...(constraints === undefined ? {} : { resourceConstraints: constraints }),
          ...(spaceToolPolicies === undefined ? {} : { spaceToolPolicies }),
          revision: { increment: 1 },
        },
      });
      await this.invalidateApprovals(tx, actor, server);
    });
    return this.grants(actor, input.connectionId);
  }

  async revoke(actor: Owner, id: string, state: "not-connected" | "cancelled" = "not-connected") {
    actor = { spaceId: actor.spaceId, userId: actor.userId };
    const server = await this.owned(actor, id);
    if (!server.catalogId) throw new IsolationError();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${id}))`;
      const current = await tx.mcpServer.findFirst({ where: { id, ...actor } });
      if (!current) throw new IsolationError();
      await tx.mcpServer.update({
        where: { id },
        data: {
          enabled: false,
          connectionState: state,
          secretId: null,
          resourceConstraints: {},
          manifest: Prisma.DbNull,
          spaceAllowedTools: [],
          spaceToolPolicies: {},
          revision: { increment: 1 },
        },
      });
      if (current.secretId)
        await tx.secret.deleteMany({
          where: { id: current.secretId, ...actor },
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

  async resourceTools(actor: Owner, id: string, kind: IntegrationResourceKind) {
    return this.withResourceConnector(actor, id, (connector, server) =>
      connector.resourceTools(server, kind, this.resourceContext(actor)),
    );
  }

  async searchResources(
    actor: Owner,
    input: {
      connectionId: string;
      kind: IntegrationResourceKind;
      toolId: string;
      args: Record<string, string>;
    },
  ) {
    return this.withResourceConnector(actor, input.connectionId, (connector, server) =>
      connector.searchResources(
        server,
        input.kind,
        input.toolId,
        input.args,
        this.resourceContext(actor),
      ),
    );
  }

  private resourceContext(actor: Owner) {
    return {
      ...actor,
      operationId: "integrations.resources",
      traceId: "integrations.resources",
      signal: AbortSignal.timeout(30_000),
    };
  }

  private async withResourceConnector<T>(
    actor: Owner,
    id: string,
    read: (connector: McpConnector, server: McpServer) => Promise<T>,
  ): Promise<T> {
    const server = await this.owned(actor, id);
    if (!server.enabled || server.connectionState !== "connected")
      throw new ORPCError("BAD_REQUEST", { message: "Connect this integration first." });
    const connector = new McpConnector(
      this.prisma,
      this.secrets,
      { network: this.network, ...this.stdio },
      this.oauth,
    );
    try {
      return await read(connector, server);
    } catch {
      throw new ORPCError("BAD_REQUEST", {
        message: "Could not load destinations; check the search fields and try again.",
      });
    } finally {
      await connector.close();
    }
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
