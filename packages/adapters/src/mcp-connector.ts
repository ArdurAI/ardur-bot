import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@ardurbot/adapter-kit";
import type { IntegrationResourceKind } from "@ardurbot/contracts";
import { IntegrationManifestSchema, isLocalMcpHost } from "@ardurbot/contracts";
import { integrationToolKind } from "@ardurbot/core";
import type { McpServer, PrismaClient, ThreadEvents } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { catalogToolPrefix } from "./approval-effect.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import { appendToolCompletionAudit } from "./executor.js";
import { grantedMcpTools, integrationResourceDenial } from "./integration-access.js";
import { captureIntegrationManifest, inputSchemaDigest } from "./integration-manifest.js";
import { resourceChoices, resourceSearchTools } from "./integration-resources.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { McpOAuthBroker, OAuthMaterial } from "./mcp-oauth.js";
import { oauthMaterialSecrets } from "./mcp-oauth.js";
import { McpSession } from "./mcp-transport.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";

type SessionEntry = { session: McpSession; revision: number; material: OAuthMaterial };
type PendingSession = { revision: number; promise: Promise<McpSession> };

/** Runtime MCP connector. Authorization is re-checked against the bot assignment on every call. */
/**
 * Stale allowlist entries are filtered out below with no error. Discovery already has the
 * live tool list, so compare once and warn when string allowlist names are missing from the
 * server. Non-string JSON values are ignored for both the missing list and the ratio.
 */
export function allowlistDrift(
  allowedTools: unknown,
  offered: Array<{ name: string }>,
): { missing: string[]; offered: number; stringAllowedCount: number } {
  const names = new Set(offered.map((tool) => tool.name));
  const allowed = Array.isArray(allowedTools) ? allowedTools : [];
  const stringAllowed = allowed.filter((name): name is string => typeof name === "string");
  return {
    missing: stringAllowed.filter((name) => !names.has(name)),
    offered: names.size,
    stringAllowedCount: stringAllowed.length,
  };
}

function reportAllowlistDrift(
  assignment: { allowAllTools: boolean; allowedTools: unknown; server: { slug: string } },
  offered: Array<{ name: string }>,
  context: { spaceId: string; botId?: string },
): void {
  if (assignment.allowAllTools) return;
  const drift = allowlistDrift(assignment.allowedTools, offered);
  if (drift.missing.length === 0) return;
  getLogger().warn(
    `mcp allowlist drift on ${assignment.server.slug}: ${drift.missing.length}/${drift.stringAllowedCount} allowed tools are not offered (server offers ${drift.offered})`,
    {
      spaceId: context.spaceId,
      botId: context.botId,
      // Cap the list: the point is to name the drift, not to print an allowlist.
      missing: drift.missing.slice(0, 10),
    },
  );
}

export class McpConnector implements ConnectorProvider {
  private static readonly active = new Set<McpConnector>();

  /** Close process-local sessions; other workers are fenced by the persisted revision. */
  static async invalidateConnection(
    serverId: string,
    owner: { spaceId: string; userId: string },
  ): Promise<void> {
    const key = `${serverId} ${owner.spaceId} ${owner.userId}`;
    await Promise.all(
      [...McpConnector.active].map(async (connector) => {
        await connector.connecting.get(key)?.promise.catch(() => undefined);
        await connector.evict(key);
      }),
    );
  }
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connecting = new Map<string, PendingSession>();
  // Discovery runs more than once per run: once up front, then again on every lazy
  // catalog access. Each attempt needs its own executionId.
  private discoverySeq = 0;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
    private readonly options: {
      stdioEnabled?: boolean;
      allowedCommands?: string[];
      network?: RemoteTransportDependencies;
      /** Audit sink for failed discovery. Without it the log line stays the only trace. */
      events?: Pick<ThreadEvents, "append">;
    } = {},
    private readonly oauth?: McpOAuthBroker,
  ) {
    McpConnector.active.add(this);
  }

  describe() {
    return {
      id: "mcp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (
      context.toolAccessMode === "all" ||
      tools.length === 0 ||
      (context.toolAccessMode !== "when-needed" && tools.length <= DIRECT_TOOL_LIMIT)
    )
      return tools;
    // The catalog wrappers must not be named `mcp_*`: Anthropic rejects Claude Code OAuth
    // requests that carry a tool whose name starts with "mcp_" (single underscore) with a
    // misleading "You're out of extra usage" 400, on every model. Direct MCP tools are
    // `mcp__server__tool` (double underscore) and are accepted; keep the wrappers off "mcp_".
    return lazyCatalogTools(catalogToolPrefix("mcp"), "mcp", "MCP", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!context.botId) return [];
    const assignments = await this.prisma.botMcpServer.findMany({
      where: {
        botId: context.botId,
        spaceId: context.spaceId,
        userId: context.userId,
        server: { enabled: true },
      },
      include: { server: true },
    });
    const groups = await Promise.all(
      assignments.map(async (assignment): Promise<ConnectorTool[]> => {
        const startedAt = Date.now();
        try {
          if (
            !grantedMcpTools(
              assignment,
              Array.isArray(assignment.allowedTools)
                ? assignment.allowedTools.filter((id): id is string => typeof id === "string")
                : [],
            ).length
          )
            return [];
          const session = await this.sessionFor(assignment.server, context);
          const listed = await session.listTools({ signal: context.signal });
          reportAllowlistDrift(assignment, listed.tools, context);
          const material = this.sessions.get(this.sessionKey(assignment.server, context))?.material;
          const secretValues = material ? oauthMaterialSecrets(material) : [];
          const granted = new Set(
            grantedMcpTools(
              assignment,
              listed.tools.map((tool) => tool.name),
            ),
          );
          const manifest = IntegrationManifestSchema.safeParse(assignment.server.manifest);
          return listed.tools
            .filter(
              (tool) =>
                granted.has(tool.name) &&
                (!assignment.server.catalogId ||
                  (manifest.success &&
                    manifest.data.tools.some(
                      (captured) =>
                        captured.id === tool.name &&
                        captured.inputSchemaDigest === inputSchemaDigest(tool.inputSchema),
                    ))),
            )
            .map((tool) => ({
              name: `mcp__${assignment.server.slug}__${tool.name}`,
              description: sanitizeConnectorError(tool.description ?? tool.name, secretValues),
              inputSchema: redactConnectorPayload(tool.inputSchema, secretValues) as Record<
                string,
                unknown
              >,
              route: {
                connectorId: "mcp",
                resourceId: assignment.serverId,
                resourceRevision: assignment.server.revision,
                toolName: tool.name,
                catalogGroup: assignment.server.slug,
              },
            }));
        } catch (error) {
          // A single unavailable server must not hide tools from other connectors.
          getLogger().error(
            `mcp discovery failed for server ${assignment.server.slug}:`,
            sanitizeConnectorError(error),
          );
          // Capture material before eviction so the audited reason stays redacted, the
          // same reason execute() captures it before callTool.
          const key = this.sessionKey(assignment.server, context);
          const material = this.sessions.get(key)?.material;
          await this.evict(key);
          await this.recordDiscoveryFailure(
            assignment.server.slug,
            error,
            context,
            startedAt,
            material ? oauthMaterialSecrets(material) : [],
          );
          return [];
        }
      }),
    );
    return groups.flat();
  }

  /**
   * Leave a failed discovery where every other tool outcome is already visible, as an
   * `agent.tool.completed` event with `outcome: "error"`. Losing a server's tools is
   * otherwise invisible: the run still ends `completed` and the model simply never sees
   * them. Discovery outside a run (settings, tool pickers) has no thread to attach to, so
   * there the log line stays the only trace.
   */
  private async recordDiscoveryFailure(
    slug: string,
    error: unknown,
    context: AdapterContext,
    startedAt: number,
    secrets: string[],
  ): Promise<void> {
    const events = this.options.events;
    if (!events || !context.runId || !context.botId) return;
    const run = await this.prisma.run
      .findUnique({ where: { id: context.runId }, select: { threadId: true } })
      .catch(() => null);
    if (!run) return;
    await appendToolCompletionAudit(
      { events },
      {
        spaceId: context.spaceId,
        threadId: run.threadId,
        botId: context.botId,
        runId: context.runId,
      },
      {
        name: `mcp__${slug}__discovery`,
        executionId: `mcp-discovery-${slug}-${context.runId}-${this.discoverySeq++}`,
        durationMs: Date.now() - startedAt,
        error,
      },
      secrets,
    );
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId !== "mcp") {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    if (!call.route.resourceId) {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (!context.botId) {
      yield { type: "error", message: "MCP tools require a bot context" };
      return;
    }
    const assignment = await this.prisma.botMcpServer.findFirst({
      where: {
        botId: context.botId,
        serverId: call.route.resourceId,
        spaceId: context.spaceId,
        userId: context.userId,
        server: { enabled: true },
      },
      include: { server: true },
    });
    if (
      !assignment ||
      !grantedMcpTools(assignment, [call.route.toolName]).length ||
      (assignment.server.catalogId && call.route.resourceRevision !== assignment.server.revision)
    ) {
      await this.evict(`${call.route.resourceId} ${context.spaceId} ${context.userId}`);
      yield { type: "error", message: "MCP tool is not assigned to this bot" };
      return;
    }
    // Capture material before callTool so a concurrent eviction/replace cannot
    // drop this call's OAuth secrets from model-visible redaction. Recompute via
    // oauthMaterialSecrets(material) so in-place token refresh stays covered.
    let material: OAuthMaterial | undefined;
    let sentWrite = false;
    const sessionKey = this.sessionKey(assignment.server, context);
    try {
      const session = await this.sessionFor(assignment.server, context);
      material = this.sessions.get(sessionKey)?.material;
      if (assignment.server.catalogId) {
        const manifest = IntegrationManifestSchema.parse(assignment.server.manifest);
        const listed = await session.listTools({ signal: context.signal });
        const live = listed.tools.find((tool) => tool.name === call.route?.toolName);
        const captured = manifest.tools.find((tool) => tool.id === call.route?.toolName);
        if (
          !live ||
          !captured ||
          captured.inputSchemaDigest !== inputSchemaDigest(live.inputSchema)
        ) {
          throw new Error("The tool changed. Review tools before continuing.");
        }
        const denial = integrationResourceDenial(assignment.server, captured, call.args);
        if (denial) throw new Error(denial);
        // Recheck after discovery: revocation must also fence an already-open session.
        const current = await this.prisma.botMcpServer.findFirst({
          where: {
            id: assignment.id,
            spaceId: context.spaceId,
            userId: context.userId,
            server: { enabled: true, revision: assignment.server.revision },
          },
          include: { server: true },
        });
        if (!current || !grantedMcpTools(current, [call.route.toolName]).length)
          throw new Error("MCP tool is not assigned to this bot");
      }
      const captured = IntegrationManifestSchema.safeParse(
        assignment.server.manifest,
      ).data?.tools.find((tool) => tool.id === call.route?.toolName);
      sentWrite = Boolean(
        assignment.server.catalogId &&
          (!captured ||
            integrationToolKind(captured.id, captured.description) !== "read" ||
            Object.entries(call.args).some(
              ([key, value]) =>
                /^(action|operation|method|command)$/i.test(key) &&
                (typeof value !== "string" || !/^(get|list|search|find|read|fetch)$/i.test(value)),
            )),
      );
      const result = await session.callTool(call.route.toolName, call.args, {
        signal: context.signal,
      });
      const secrets = material ? oauthMaterialSecrets(material) : [];
      yield { type: "result", data: redactConnectorPayload(result, secrets) };
    } catch (error) {
      // A thrown call means the transport or auth broke; drop the session so the next call reconnects.
      const secrets = material ? oauthMaterialSecrets(material) : [];
      await this.evict(sessionKey);
      yield {
        type: "error",
        message: sentWrite
          ? "Delivery could not be confirmed"
          : sanitizeConnectorError(error, secrets),
        ...(sentWrite ? { uncertain: true } : {}),
      };
    }
  }

  /** Owner-scoped settings discovery; callers must check ownership before passing the row. */
  async inspectServer(server: McpServer, context: AdapterContext) {
    const session = await this.sessionFor(server, context);
    const listed = await session.listTools({ signal: context.signal });
    const material = this.sessions.get(this.sessionKey(server, context))?.material;
    return captureIntegrationManifest(
      listed.tools,
      session.serverVersion(),
      material ? oauthMaterialSecrets(material) : [],
    );
  }

  async resourceTools(server: McpServer, kind: IntegrationResourceKind, context: AdapterContext) {
    const session = await this.sessionFor(server, context);
    const listed = await session.listTools({ signal: context.signal });
    const manifest = IntegrationManifestSchema.parse(server.manifest);
    const material = this.sessions.get(this.sessionKey(server, context))?.material;
    const secrets = material ? oauthMaterialSecrets(material) : [];
    return resourceSearchTools(server.catalogId, kind, manifest, listed.tools).filter((tool) =>
      tool.fields.every((field) => !secrets.some((secret) => field.name.includes(secret))),
    );
  }

  async searchResources(
    server: McpServer,
    kind: IntegrationResourceKind,
    toolId: string,
    args: Record<string, string>,
    context: AdapterContext,
  ) {
    const offered = await this.resourceTools(server, kind, context);
    const tool = offered.find((tool) => tool.id === toolId);
    if (
      !tool ||
      tool.fields.some((field) => field.required && !args[field.name]?.trim()) ||
      Object.keys(args).some((key) => !tool.fields.some((field) => field.name === key))
    )
      throw new Error("Review the search fields and try again.");
    const current = await this.prisma.mcpServer.findFirst({
      where: {
        id: server.id,
        spaceId: context.spaceId,
        userId: context.userId,
        enabled: true,
        revision: server.revision,
      },
    });
    if (current?.connectionState !== "connected")
      throw new Error("Connect this integration first.");
    const session = await this.sessionFor(server, context);
    const result = await session.callTool(toolId, args, { signal: context.signal });
    if (result.isError) throw new Error("Could not load destinations.");
    const material = this.sessions.get(this.sessionKey(server, context))?.material;
    return resourceChoices(
      kind,
      redactConnectorPayload(result, material ? oauthMaterialSecrets(material) : []),
    );
  }

  async close(): Promise<void> {
    McpConnector.active.delete(this);
    await Promise.allSettled([...this.connecting.values()].map(({ promise }) => promise));
    await Promise.all([...this.sessions.values()].map(({ session }) => session.close()));
    this.sessions.clear();
    this.connecting.clear();
  }

  private sessionKey(server: McpServer, context: AdapterContext): string {
    // Identity headers are applied once, at connect time, so a session is only
    // valid for the identity it connected as. The key has to carry that identity.
    return `${server.id} ${context.spaceId} ${context.userId}`;
  }

  private async evict(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    this.sessions.delete(sessionKey);
    await entry.session.close();
  }

  private async sessionFor(server: McpServer, context: AdapterContext): Promise<McpSession> {
    const sessionKey = this.sessionKey(server, context);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.revision === server.revision) return existing.session;
    const pending = this.connecting.get(sessionKey);
    if (pending?.revision === server.revision) return pending.promise;
    if (pending) {
      await pending.promise.catch(() => undefined);
      await this.evict(sessionKey);
      return this.sessionFor(server, context);
    }
    if (existing) await this.evict(sessionKey);

    const promise = this.connectSession(server, context).then(({ session, material }) => {
      this.sessions.set(sessionKey, { session, revision: server.revision, material });
      return session;
    });
    this.connecting.set(sessionKey, { revision: server.revision, promise });
    try {
      return await promise;
    } finally {
      if (this.connecting.get(sessionKey)?.promise === promise) this.connecting.delete(sessionKey);
    }
  }

  private async connectSession(
    server: McpServer,
    context: AdapterContext,
  ): Promise<{ session: McpSession; material: OAuthMaterial }> {
    const session = new McpSession({ name: `ardurbot-${server.slug}` });
    // Hoisted so a throw after the secret is decoded can still hand the material out.
    let material: OAuthMaterial | undefined;
    try {
      const secret = server.secretId
        ? await this.prisma.secret.findFirst({
            where: {
              id: server.secretId,
              spaceId: context.spaceId,
              userId: context.userId,
            },
          })
        : null;
      material = secret
        ? (JSON.parse(this.secrets.load(secret.ciphertext, secret.id)) as OAuthMaterial)
        : {};
      const loaded = { material, ...(secret ? { secretId: secret.id } : {}) };
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      const env = { ...(material.env ?? {}) };
      if (server.transport === "stdio") {
        if (!this.options.stdioEnabled) throw new Error("MCP stdio is disabled");
        await session.connectStdio({
          command: String(server.command ?? ""),
          args,
          env,
          allowedCommands: this.options.allowedCommands ?? [],
          signal: context.signal,
        });
      } else {
        if (!server.endpoint) throw new Error("MCP endpoint is required");
        const endpoint = new URL(server.endpoint);
        const localHttp = endpoint.protocol === "http:" && isLocalMcpHost(endpoint.hostname);
        const authProvider =
          !localHttp && this.oauth
            ? await this.oauth.providerFor(server, context, loaded)
            : undefined;
        const staticToken = material.secret
          ? material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`
          : undefined;
        const headers = {
          ...(material.headers ?? {}),
          ...(staticToken ? { Authorization: staticToken } : {}),
        };
        await session.connectRemote({
          url: server.endpoint,
          urlPolicy: { allowHttpLocalhost: localHttp, allowLocalHttpCredentials: localHttp },
          transport: server.transport === "sse" ? "sse" : "streamable-http",
          allowLegacySse: server.transport === "sse",
          headerPolicy: { headers },
          fallbackToSse: false,
          authProvider,
          network: this.options.network,
          signal: context.signal,
        });
      }
      return { session, material };
    } catch (error) {
      await session.close().catch(() => undefined);
      // Redact here, while the material is still in hand. This one rejection is handed
      // to every caller waiting on the same pending connect, and none of them can see
      // the secrets: the session never reached `sessions`. Sanitizing per caller would
      // cover only whoever looked first.
      if (!material) throw error;
      throw new Error(sanitizeConnectorError(error, oauthMaterialSecrets(material)));
    }
  }
}
