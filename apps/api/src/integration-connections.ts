import { randomUUID } from "node:crypto";
import type {
  EncryptedSecretStore,
  McpHostClient,
  McpOAuthBroker,
  RemoteConnectorDependencies,
} from "@ardurbot/adapters";
import {
  assertSafeRemoteUrl,
  CONSENT_TTL_MS,
  captureIntegrationManifest,
  connectableIntegration,
  hostIntegrationTools,
  INTEGRATION_HEALTH_INTERVAL_MS,
  integrationById,
  integrationCatalog,
  integrationFailure,
  McpConnector,
  McpReauthorizationRequiredError,
} from "@ardurbot/adapters";
import type {
  Actor,
  HostIntegration,
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
    transport: server.transport,
    consentStartedAt: server.consentStartedAt?.toISOString() ?? null,
    lastCheckedAt: server.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: server.lastSuccessAt?.toISOString() ?? null,
    lastUsedAt: server.lastUsedAt?.toISOString() ?? null,
    lastError: server.lastError ?? null,
    recentErrors: Array.isArray(server.recentErrors)
      ? (server.recentErrors as Array<{ at: string; message: string }>)
      : [],
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
    readonly hostSignIns: (actor: Owner) => Promise<HostIntegration[]> = async () => [],
  ) {}

  async list(actor: Owner) {
    await this.expireConsent(actor);
    const servers = await this.prisma.mcpServer.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, catalogId: { not: null } },
      include: { assignments: true },
      orderBy: { createdAt: "desc" },
    });
    return {
      webUrl: new URL("/", this.webOrigin).toString(),
      hostSignIns: await this.hostSignIns(actor),
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
    if (server.transport === "host-cli") return this.hostManifest(actor, server.catalogId!);
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

  private async hostManifest(actor: Owner, catalogId: string): Promise<IntegrationManifest> {
    const identity = (await this.hostSignIns(actor)).find((entry) => entry.id === catalogId);
    if (identity?.state === "needs-sign-in")
      throw new McpReauthorizationRequiredError(catalogId, "host_sign_in_required");
    if (identity?.state !== "signed-in") throw new Error("Host sign-in is unavailable.");
    return {
      ...captureIntegrationManifest(hostIntegrationTools, "1"),
      account: identity.identity,
      workspace: identity.workspace,
      scopes: [],
    };
  }

  private async connectHost(actor: Owner, catalogId: string, connectionId?: string) {
    const descriptor = integrationById(catalogId);
    if (!descriptor?.hostCli) throw new IsolationError();
    const manifest = await this.hostManifest(actor, catalogId);
    const existing = connectionId ? await this.owned(actor, connectionId) : null;
    if (existing && (existing.catalogId !== catalogId || existing.transport !== "host-cli"))
      throw new IsolationError();
    if (existing) await this.revoke(actor, existing.id);
    const data = {
      ...actor,
      catalogId,
      name: descriptor.name,
      transport: "host-cli",
      enabled: true,
      connectionState: "connected",
      manifest,
      lastSuccessAt: new Date(),
      lastCheckedAt: new Date(),
      lastError: null,
      secretId: null,
    };
    const server = existing
      ? await this.prisma.mcpServer.update({ where: { id: existing.id }, data })
      : await this.prisma.mcpServer.create({
          data: { ...data, slug: `host-${catalogId}-${randomUUID().slice(0, 8)}` },
        });
    return { connection: connectionDto(server), authorizationUrl: null, sessionId: null };
  }

  async beginAuthorization(actor: Owner, input: { serverId: string; redirectUri: string }) {
    const server = await this.owned(actor, input.serverId);
    let started: Awaited<ReturnType<McpOAuthBroker["begin"]>>;
    try {
      started = await this.oauth.begin({
        ...input,
        spaceId: actor.spaceId,
        userId: actor.userId,
      });
    } catch (error) {
      if (!server.catalogId) await this.recordFailure(actor, server, error);
      throw error;
    }
    if (started.status !== "authorization_required") await this.capture(actor, input.serverId);
    else if (!server.catalogId && server.connectionState !== "connected")
      // A server that is not connected yet can drop its previous result. A connected
      // server stays connected until this attempt records an outcome; the client
      // tells the attempts apart by revision.
      await this.prisma.mcpServer.updateMany({
        where: {
          id: server.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          enabled: true,
          revision: server.revision,
        },
        data: { connectionState: "not-connected", revision: { increment: 1 } },
      });
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
      authKind?: "oauth" | "token" | "host";
      oauthClient?: { clientId: string; clientSecret?: string };
    },
  ) {
    actor = { spaceId: actor.spaceId, userId: actor.userId };
    if (input.authKind === "host")
      return this.connectHost(actor, input.catalogId, input.connectionId);
    const prior = input.connectionId ? await this.owned(actor, input.connectionId) : null;
    const descriptor = connectableIntegration(
      input.catalogId,
      input.host ?? (prior?.catalogId === "azure" ? (prior.endpoint ?? undefined) : undefined),
    );
    if (descriptor.transport === "host-cli")
      throw new ORPCError("BAD_REQUEST", { message: "Use the sign-in on this computer." });
    const authKind = input.authKind ?? descriptor.authKind;
    let oauthApp = input.oauthClient
      ? {
          client_id: input.oauthClient.clientId,
          ...(input.oauthClient.clientSecret
            ? { client_secret: input.oauthClient.clientSecret }
            : {}),
          token_endpoint_auth_method: input.oauthClient.clientSecret
            ? ("client_secret_post" as const)
            : ("none" as const),
        }
      : this.oauthApp(descriptor.id);
    if (!oauthApp && prior?.secretId && prior.catalogId === descriptor.id) {
      const secret = await this.prisma.secret.findFirst({
        where: { id: prior.secretId, ...actor },
      });
      if (secret) {
        try {
          const stored = JSON.parse(this.secrets.load(secret.ciphertext, secret.id)) as {
            oauth?: { clientInformation?: typeof oauthApp };
          };
          oauthApp = stored.oauth?.clientInformation;
        } catch {
          throw new ORPCError("BAD_REQUEST", { message: "Enter the client registration again." });
        }
      }
    }
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
        data: {
          enabled: true,
          connectionState: "awaiting-consent",
          consentStartedAt: new Date(),
          lastError: null,
        },
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
          consentStartedAt: new Date(),
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
        redirectUri: new URL("/api/oauth/done", this.webOrigin).toString(),
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
    try {
      const manifest = await this.tools(actor, id);
      const previous = IntegrationManifestSchema.safeParse(server.manifest);
      // Optional profile scopes or a profile endpoint outage must not erase a known identity.
      if (previous.success && server.connectionState === "connected") {
        manifest.account ??= previous.data.account;
        manifest.workspace ??= previous.data.workspace;
      }
      const tools = (value: IntegrationManifest) =>
        JSON.stringify([...value.tools].sort((a, b) => a.id.localeCompare(b.id)));
      const changed =
        !previous.success ||
        tools(previous.data) !== tools(manifest) ||
        previous.data.account !== manifest.account ||
        previous.data.workspace !== manifest.workspace;
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
            consentStartedAt: null,
            lastCheckedAt: new Date(),
            lastSuccessAt: new Date(),
            lastError: null,
            ...(changed
              ? { spaceAllowedTools: [], spaceToolPolicies: {}, revision: { increment: 1 } }
              : {}),
          },
        });
        if (!captured.count) return;
        if (!changed) return;
        // A refreshed manifest never silently inherits grants to an older tool definition.
        await tx.botMcpServer.updateMany({
          where: { serverId: id, spaceId: actor.spaceId, userId: actor.userId },
          data: { allowedTools: [], allowAllTools: false, needsReview: true },
        });
        await this.invalidateApprovals(tx, actor, server);
      });
      await McpConnector.invalidateConnection(id, actor);
    } catch (error) {
      await this.recordFailure(actor, server, error);
      if (!server.catalogId)
        throw new Error("Could not connect this server. Check its configuration and try again.");
    }
  }

  private async recordFailure(actor: Owner, server: McpServer, error: unknown) {
    const message = integrationFailure(error);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${server.id}))`;
      const where = {
        id: server.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        enabled: true,
        revision: server.revision,
      };
      const current = await tx.mcpServer.findFirst({ where });
      if (!current || current.revision !== server.revision) return;
      // A rejected older token must not invalidate a successful concurrent refresh.
      if (
        error instanceof McpReauthorizationRequiredError &&
        current.secretId !== server.secretId &&
        current.connectionState === "connected"
      )
        return;
      await tx.mcpServer.updateMany({
        where,
        data: {
          // A catalog health check keeps its connection through a failed read; a custom
          // server shows the result of the discovery the owner just ran.
          ...(message.startsWith("Needs sign-in")
            ? { connectionState: "needs-sign-in" }
            : current.connectionState === "connected" && server.catalogId
              ? {}
              : { connectionState: "discovery-failed" }),
          lastCheckedAt: new Date(),
          lastError: message,
          recentErrors: [
            ...(Array.isArray(current.recentErrors) ? current.recentErrors : []),
            { at: new Date().toISOString(), message },
          ].slice(-10),
        },
      });
    });
  }

  async expireConsent(actor?: Owner) {
    const cutoff = new Date(Date.now() - CONSENT_TTL_MS);
    const rows = await this.prisma.mcpServer.findMany({
      where: {
        ...(actor ? { userId: actor.userId, spaceId: actor.spaceId } : {}),
        connectionState: "awaiting-consent",
        consentStartedAt: { lte: cutoff },
      },
    });
    for (const row of rows) {
      if (
        row.connectionState !== "awaiting-consent" ||
        (row.consentStartedAt?.getTime() ?? row.updatedAt?.getTime() ?? Date.now()) >
          Date.now() - CONSENT_TTL_MS
      )
        continue;
      await this.revoke({ userId: row.userId, spaceId: row.spaceId }, row.id, "not-connected", {
        revision: row.revision,
        cutoff,
      });
    }
  }

  /** A bounded, non-overlapping sweep. Only integrations granted to a bot make network calls. */
  async checkGranted() {
    await this.expireConsent();
    const rows = await this.prisma.mcpServer.findMany({
      where: {
        enabled: true,
        catalogId: { not: null },
        connectionState: "connected",
        assignments: { some: { needsReview: false } },
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lte: new Date(Date.now() - INTEGRATION_HEALTH_INTERVAL_MS) } },
        ],
      },
      take: 50,
      orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    });
    for (const row of rows)
      await this.capture({ userId: row.userId, spaceId: row.spaceId }, row.id);
  }

  startHealthChecks() {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.checkGranted()
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
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
    kind: "catalog" | "mcp" = "catalog",
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
      if (
        !server ||
        (kind === "catalog"
          ? !server.catalogId || !integrationById(server.catalogId)?.available
          : Boolean(server.catalogId))
      )
        throw new IsolationError();
      const manifest = IntegrationManifestSchema.safeParse(server.manifest);
      if (server.connectionState !== "connected" || !manifest.success)
        throw new Error("Connect this integration before choosing tools.");
      const descriptor = server.catalogId ? integrationById(server.catalogId) : undefined;
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
          .filter((tool) => descriptor?.toolPolicies[tool.id]?.approval !== "disabled")
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
          ...(server.transport === "host-cli" ? { computer: { kind: "desktop" } } : {}),
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

  async revoke(
    actor: Owner,
    id: string,
    state: "not-connected" | "cancelled" = "not-connected",
    expired?: { revision: number; cutoff: Date },
  ) {
    actor = { spaceId: actor.spaceId, userId: actor.userId };
    const server = await this.owned(actor, id);
    if (!server.catalogId) throw new IsolationError();
    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${id}))`;
      const current = await tx.mcpServer.findFirst({ where: { id, ...actor } });
      if (!current) throw new IsolationError();
      if (
        expired &&
        (current.revision !== expired.revision ||
          current.connectionState !== "awaiting-consent" ||
          (current.consentStartedAt ?? current.updatedAt) > expired.cutoff)
      )
        return false;
      await tx.mcpServer.update({
        where: { id },
        data: {
          enabled: false,
          connectionState: state,
          consentStartedAt: null,
          lastError: expired ? "Sign-in timed out." : null,
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
      return true;
    });
    if (!revoked) return { ok: true as const };
    this.oauth.forgetPending({ serverId: id, ...actor });
    await McpConnector.invalidateConnection(id, actor);
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
