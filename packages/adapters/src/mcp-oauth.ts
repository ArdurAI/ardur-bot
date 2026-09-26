import { randomUUID } from "node:crypto";
import {
  isLocalMcpHost,
  mcpCredentialConflict,
  mcpReauthorizationDeclinedDiagnostic,
  mcpSignInDiagnostic,
} from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { transientIntegrationError } from "./integration-lifecycle.js";
import { secureFetch, validateUrl, withEndpointOriginFallback } from "./mcp-transport.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";

type OAuthState = {
  authorizationRevision?: number;
  tokens?: OAuthTokens;
  obtainedAt?: number;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  redirectUri?: string;
  codeVerifier?: string;
};

export type OAuthMaterial = {
  redactions?: string[];
  command?: string;
  args?: string[];
  cwd?: string;
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: OAuthState;
};

/** Values that must never appear in model-visible tool results or errors. */
export function oauthMaterialSecrets(material: OAuthMaterial): string[] {
  const values: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    values.push(value);
    const bearer = value.match(/^Bearer\s+(.+)$/i);
    if (bearer?.[1]) values.push(bearer[1]);
  };
  for (const value of material.redactions ?? []) add(value);
  for (const value of material.args ?? []) if (!value.startsWith("-")) add(value);
  add(material.secret);
  add(material.oauth?.tokens?.access_token);
  add(material.oauth?.tokens?.refresh_token);
  const client = material.oauth?.clientInformation;
  if (client && "client_secret" in client && typeof client.client_secret === "string") {
    add(client.client_secret);
  }
  for (const [key, value] of Object.entries(material.headers ?? {})) {
    if (isAuthHeaderKey(key)) {
      // Cookie / X-Session / Authorization always carry auth material, including short values.
      add(value);
    } else if (
      isExplicitCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: true })
    ) {
      add(value);
    } else if (
      isAmbiguousCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: false })
    ) {
      add(value);
    }
  }
  for (const [key, value] of Object.entries(material.env ?? {})) {
    if (isExplicitCredentialKey(key) && looksLikeSecretValue(value, { allowNumeric: true })) {
      add(value);
    } else if (
      isAmbiguousCredentialKey(key) &&
      looksLikeSecretValue(value, { allowNumeric: false })
    ) {
      add(value);
    }
  }
  return [...new Set(values)];
}

/** Headers whose values are credentials even when short (e.g. Cookie, X-Session). */
function isAuthHeaderKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "set_cookie" ||
    normalized === "x_session" ||
    normalized === "x_api_key" ||
    normalized === "api_key" ||
    normalized === "x_auth_token"
  );
}

/** Explicit credential keys (access_token, api_key, …); numeric values stay redacted. */
function isExplicitCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (isAuthHeaderKey(key)) return true;
  return /(?:^|_)(secret|password|credential|access_token|refresh_token|id_token|auth_token|session_token|session_id|session_key|session_secret|api_key|api_token)$/.test(
    normalized,
  );
}

/** Ambiguous *_token keys where numeric-only values are usually config, not secrets. */
function isAmbiguousCredentialKey(key: string): boolean {
  if (isExplicitCredentialKey(key)) return false;
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (/(?:^|_)token$/.test(normalized)) {
    return !/(timeout|ttl|max|count|type|mode|name)$/.test(normalized);
  }
  return false;
}

/**
 * Values under credential-shaped keys must look like secrets before entering
 * global substring redaction. Ordinary enums such as "production" or "oauth"
 * would otherwise corrupt unrelated tool output. Numeric-only filtering applies
 * only to ambiguous keys — explicit carriers still register OTP-like tokens.
 */
function looksLikeSecretValue(value: string, options: { allowNumeric?: boolean } = {}): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (COMMON_CONFIG_VALUES.has(trimmed.toLowerCase())) return false;
  if (!options.allowNumeric && /^\d+(\.\d+)?$/.test(trimmed)) return false;
  return true;
}

const COMMON_CONFIG_VALUES = new Set([
  "production",
  "development",
  "staging",
  "test",
  "testing",
  "oauth",
  "openid",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "none",
  "null",
  "debug",
  "info",
  "warn",
  "error",
  "http",
  "https",
  "local",
  "localhost",
  "enabled",
  "disabled",
  "default",
  "auto",
  "manual",
  "read",
  "write",
  "sync",
  "async",
]);

type ServerRef = {
  id: string;
  endpoint: string | null;
  secretId: string | null;
  catalogId?: string | null;
  imported?: unknown;
  revision?: number;
};
type ActorRef = { spaceId: string; userId: string };

export class McpReauthorizationRequiredError extends Error {
  readonly code = "MCP_REAUTHORIZATION_REQUIRED";
  constructor(
    readonly serverId: string,
    reason: string | null = "refresh_unavailable",
  ) {
    super(mcpSignInDiagnostic(reason));
    this.name = "McpReauthorizationRequiredError";
  }
}

/** The callback belongs to an attempt that was replaced or already finished. */
export class McpOAuthAttemptReplacedError extends Error {
  readonly code = "MCP_OAUTH_REPLACED";
  readonly result = "replaced" as const;
  constructor() {
    super("replaced");
    this.name = "McpOAuthAttemptReplacedError";
  }
}

/** The server demanded sign-in but offered no authorization server. Provider text stays off the screen. */
export class McpOAuthUnavailableError extends Error {
  readonly code = "MCP_OAUTH_UNAVAILABLE";
  constructor(cause: unknown) {
    super("This server did not offer browser sign-in. Enter a token instead.", { cause });
    this.name = "McpOAuthUnavailableError";
  }
}

/** The authorization server has no dynamic client registration, so a client ID is needed. */
export class McpClientRegistrationRequiredError extends Error {
  readonly code = "MCP_CLIENT_REGISTRATION_REQUIRED";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "McpClientRegistrationRequiredError";
  }
}

export function isMcpOAuthAttemptReplaced(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "MCP_OAUTH_REPLACED") return true;
  if ("result" in error && error.result === "replaced") return true;
  return error instanceof Error && error.cause !== error && isMcpOAuthAttemptReplaced(error.cause);
}

type ProviderOptions = {
  redirectUri?: string;
  state?: string;
  onAuthorization?: (url: URL) => void;
  refresh?: (force: boolean) => Promise<OAuthState>;
  rejected?: () => Promise<void>;
};

/** One SDK OAuth provider backed by the same encrypted material used at runtime. */
export class StoredMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private readonly runtimeState = randomUUID();
  private persistQueue = Promise.resolve();
  private refreshing?: Promise<void>;
  private tokenSessionId?: string;

  /** Token saves after this point match the attempt that is still pending. */
  guardTokenWrite(sessionId: string): void {
    this.tokenSessionId = sessionId;
  }

  constructor(
    readonly serverId: string,
    private readonly material: OAuthMaterial,
    private readonly persistMaterial: (
      material: OAuthMaterial,
      pendingSessionId?: string,
    ) => Promise<void>,
    private readonly options: ProviderOptions = {},
  ) {
    if (options.redirectUri) {
      this.material.oauth = { ...(this.material.oauth ?? {}), redirectUri: options.redirectUri };
    }
  }

  get redirectUrl(): string | undefined {
    return this.options.redirectUri ?? this.material.oauth?.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl;
    if (!redirectUri) throw new McpReauthorizationRequiredError(this.serverId);
    const hostname = new URL(redirectUri).hostname;
    const applicationType = hostname === "localhost" || hostname === "127.0.0.1" ? "native" : "web";
    return {
      redirect_uris: [redirectUri],
      client_name: "Ardur Bot",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: applicationType,
    } as OAuthClientMetadata;
  }

  state(): string {
    return this.options.state ?? this.runtimeState;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.material.oauth?.clientInformation;
  }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.oauth().clientInformation = value;
    await this.persist();
  }
  tokens(): OAuthTokens | undefined {
    return this.material.oauth?.tokens;
  }
  get managesTokenRefresh(): boolean {
    return Boolean(this.options.refresh);
  }
  async rejectTokens(): Promise<never> {
    await this.options.rejected?.();
    delete this.oauth().tokens;
    throw new McpReauthorizationRequiredError(this.serverId, "invalid_token");
  }
  async prepareTokens(force = false): Promise<void> {
    const oauth = this.material.oauth;
    if (this.options.refresh && !oauth?.tokens)
      throw new McpReauthorizationRequiredError(this.serverId);
    const expires = oauth?.tokens?.expires_in;
    if (
      !force &&
      (!expires || !oauth?.obtainedAt || Date.now() < oauth.obtainedAt + expires * 1000 - 60_000)
    )
      return;
    if (!this.options.refresh) return;
    this.refreshing ??= this.options
      .refresh(force)
      .then((value) => {
        this.material.oauth = value;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    await this.refreshing;
  }
  async saveTokens(value: OAuthTokens): Promise<void> {
    const oauth = this.oauth();
    oauth.tokens = {
      ...value,
      ...(value.refresh_token
        ? {}
        : oauth.tokens?.refresh_token
          ? { refresh_token: oauth.tokens.refresh_token }
          : {}),
    };
    oauth.obtainedAt = Date.now();
    await this.persist();
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    let authorizationUrl: URL;
    try {
      authorizationUrl = validateUrl(url, { allowHttpLocalhost: true });
    } catch (error) {
      if (!this.options.onAuthorization) {
        await this.invalidateCredentials("tokens");
      }
      throw error;
    }
    this.authorizationUrl = authorizationUrl;
    if (this.options.onAuthorization) {
      this.options.onAuthorization(authorizationUrl);
      return;
    }
    // Runtime re-auth needs the user; drop the dead tokens so status reads "reconnect".
    await this.invalidateCredentials("tokens");
    throw new McpReauthorizationRequiredError(this.serverId);
  }
  async saveCodeVerifier(value: string): Promise<void> {
    this.oauth().codeVerifier = value;
    await this.persist();
  }
  codeVerifier(): string {
    const verifier = this.material.oauth?.codeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing");
    return verifier;
  }
  // RFC 8707 resource binding: only accept a self-declared canonical resource
  // that is itself a well-formed HTTPS (or localhost) URL. Providers like Brex
  // advertise an internal alias for their public origin, so cross-host
  // resources are allowed, but malformed or cleartext resources are rejected
  // and the SDK falls back to deriving the resource from the server URL.
  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (!resource) return undefined;
    try {
      return validateUrl(resource);
    } catch {
      return undefined;
    }
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.oauth().discoveryState = value;
    await this.persist();
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.material.oauth?.discoveryState;
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      const redirectUri = this.redirectUrl;
      this.material.oauth = redirectUri ? { redirectUri } : undefined;
    } else if (this.material.oauth) {
      if (scope === "client") delete this.material.oauth.clientInformation;
      if (scope === "tokens") {
        delete this.material.oauth.tokens;
        delete this.material.oauth.obtainedAt;
      }
      if (scope === "verifier") delete this.material.oauth.codeVerifier;
      if (scope === "discovery") delete this.material.oauth.discoveryState;
    }
    await this.persist();
  }

  private oauth(): OAuthState {
    if (!this.material.oauth) this.material.oauth = {};
    return this.material.oauth;
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.material);
    const pendingSessionId = this.tokenSessionId;
    const next = this.persistQueue.then(() => this.persistMaterial(snapshot, pendingSessionId));
    this.persistQueue = next.catch(() => undefined);
    await next;
  }
}

type Pending = {
  serverId: string;
  spaceId: string;
  userId: string;
  endpoint: string;
  provider: StoredMcpOAuthProvider;
  createdAt: number;
  expiry?: ReturnType<typeof setTimeout>;
};

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_SESSIONS = 100;

/** OAuth traffic runs through the same URL policy as runtime MCP requests
 * (HTTPS enforced, redirects rejected), with the endpoint-origin fallback
 * layered on top for providers like Brex. */
function oauthFetch(
  endpoint: string,
  network: RemoteTransportDependencies,
  material: OAuthMaterial = {},
): { fetch: typeof fetch; close: () => Promise<void>; headers: Record<string, string> } {
  const url = new URL(endpoint);
  const localHttp = url.protocol === "http:" && isLocalMcpHost(url.hostname);
  const headers = {
    ...material.headers,
    ...(material.secret
      ? {
          Authorization: material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`,
        }
      : {}),
  };
  const safeFetch = secureFetch(
    url,
    { allowHttpLocalhost: localHttp, allowLocalHttpCredentials: localHttp },
    { headers },
    network,
  );
  return {
    headers,
    fetch: withEndpointOriginFallback(url.origin, safeFetch),
    close: () => safeFetch.close(),
  };
}

/**
 * Lock order for a write that bumps a server's revision: the import that owns the server
 * first, then its credential material. Import, undo and credential setup use this order.
 */
export async function lockMcpServerRevision(
  tx: Prisma.TransactionClient,
  serverId: string,
  owner: ActorRef,
): Promise<void> {
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const server = await tx.mcpServer.findFirst({
    where: { id: serverId, ...scope },
    select: { imported: true },
  });
  if (server?.imported) {
    const receipt = await tx.localImportRecord.findFirst({
      where: { targetId: serverId, removedAt: null, config: scope },
    });
    if (receipt)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-import:${receipt.configId}`}, 0))`;
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${serverId}))`;
}

/**
 * The one way a connection change bumps a server's revision: credentials, discovered tools
 * and grants. An imported server's current receipt moves with it, so import can still
 * refresh and undo that server. Definition edits never come through here, so a receipt a
 * manual edit left behind stays a conflict. Returns false when `where` matched nothing.
 */
export async function bumpMcpServerRevision(
  tx: Prisma.TransactionClient,
  serverId: string,
  owner: ActorRef,
  data: Prisma.McpServerUncheckedUpdateManyInput = {},
  where: Prisma.McpServerWhereInput = {},
): Promise<boolean> {
  const scope = { spaceId: owner.spaceId, userId: owner.userId };
  const saved = await tx.mcpServer.updateMany({
    where: { ...where, id: serverId, ...scope },
    data: { ...data, revision: { increment: 1 } },
  });
  if (!saved.count) return false;
  const server = await tx.mcpServer.findFirst({
    where: { id: serverId, ...scope },
    select: { imported: true, revision: true },
  });
  if (server?.imported)
    await tx.localImportRecord.updateMany({
      where: {
        targetId: serverId,
        targetRevision: server.revision - 1,
        removedAt: null,
        config: scope,
      },
      data: { targetRevision: server.revision },
    });
  return true;
}

/**
 * Why a challenged probe produced no authorization URL, decided by what discovery found
 * and never by provider text: no authorization server, or one without dynamic client
 * registration. A network failure, a refused redirect or a rejected registration stays
 * the error it was.
 */
function signInFailure(error: unknown, provider: StoredMcpOAuthProvider): unknown {
  const discovery = provider.discoveryState();
  if (
    !discovery ||
    transientIntegrationError(error) ||
    (error instanceof Error && transientIntegrationError(error.cause))
  )
    return error;
  const metadata = discovery.authorizationServerMetadata;
  if (!metadata) return new McpOAuthUnavailableError(error);
  if (!metadata.registration_endpoint && !provider.clientInformation())
    return new McpClientRegistrationRequiredError(error);
  return error;
}

export class McpOAuthBroker {
  private readonly pending = new Map<string, Pending>();
  /** Tokens that were working before this attempt, so a failed exchange can put them back. */
  private readonly priorConnectedMaterial = new Map<
    string,
    { at: number; material: OAuthMaterial }
  >();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
    private readonly network: RemoteTransportDependencies = {},
  ) {}

  async statusFor(
    server: ServerRef,
    context: ActorRef,
  ): Promise<"none" | "connected" | "reconnect"> {
    const { material } = await this.loadMaterial(server, context);
    if (material.oauth?.tokens) return "connected";
    return material.oauth ? "reconnect" : "none";
  }

  /** What a server listing may say about stored material, without returning any of it. */
  statusForCiphertext(
    ciphertext: string | undefined,
    recordId: string | undefined,
  ): { oauthStatus: "none" | "connected" | "reconnect"; credentialConflict: boolean } {
    const material = ciphertext && recordId ? this.read(ciphertext, recordId) : {};
    return {
      oauthStatus: material.oauth?.tokens ? "connected" : material.oauth ? "reconnect" : "none",
      // Saved before one credential was enforced; both are still sent until one is removed.
      credentialConflict: mcpCredentialConflict(material) !== null,
    };
  }

  async providerFor(
    server: ServerRef,
    context: ActorRef,
    loaded?: { material: OAuthMaterial; secretId?: string },
  ): Promise<OAuthClientProvider | undefined> {
    const material = loaded ?? (await this.loadMaterial(server, context));
    if (!material.material.oauth) return undefined;
    return this.createProvider(server, context, material, {
      refresh: (force) => this.refreshMaterial(server, context, material.material, force),
      rejected: async () => {
        await this.rejectMaterial(server, context, material.material);
      },
    });
  }

  private async rejectMaterial(server: ServerRef, context: ActorRef, previous: OAuthMaterial) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${server.id}))`;
      const current = await tx.mcpServer.findFirst({
        where: { id: server.id, ...context, enabled: true, revision: server.revision },
      });
      const row = current?.secretId
        ? await tx.secret.findFirst({ where: { id: current.secretId, ...context } })
        : null;
      if (!current || !row) return;
      const material = this.read(row.ciphertext, row.id);
      if (material.oauth?.tokens?.access_token !== previous.oauth?.tokens?.access_token) return;
      if (material.oauth) delete material.oauth.tokens;
      const stored = await this.secrets.put(JSON.stringify(material), {
        ...context,
        operationId: "mcp.refresh",
        traceId: "mcp.refresh",
        signal: AbortSignal.timeout(15_000),
      });
      await tx.secret.create({ data: { ...stored, ...context, kind: "mcp" } });
      await tx.mcpServer.update({
        where: { id: server.id },
        data: {
          secretId: stored.id,
          connectionState: "needs-sign-in",
          lastError: mcpSignInDiagnostic("invalid_token"),
        },
      });
      await tx.secret.deleteMany({ where: { id: row.id, ...context } });
    });
  }

  /** Resolve the owner exclusively from the unguessable, expiring, single-use state. */
  async completeRedirect(input: { state: string; code?: string; error?: string }) {
    const session = await this.prisma.mcpOAuthSession.findFirst({
      where: { id: input.state, createdAt: { gte: new Date(Date.now() - PENDING_TTL_MS) } },
    });
    if (!session) throw new Error("MCP OAuth session is invalid or expired");
    const actor = { spaceId: session.spaceId, userId: session.userId };
    try {
      if (!input.code || input.error) throw new Error("Authorization declined");
      const serverId = await this.complete({
        code: input.code,
        state: input.state,
        sessionId: input.state,
        ...actor,
      });
      return { ...actor, serverId };
    } catch (error) {
      if (error instanceof McpOAuthAttemptReplacedError) throw error;
      const pending = this.pending.get(input.state);
      if (pending) this.discardPending(input.state, pending);
      await this.prisma.mcpOAuthSession.deleteMany({ where: { id: input.state, ...actor } });
      await this.recordAttemptFailure({
        serverId: session.serverId,
        sessionId: input.state,
        ...actor,
        kind: input.error === "access_denied" ? "declined" : "failed",
      });
      throw new Error("MCP OAuth sign-in failed");
    }
  }

  /**
   * Record this attempt's outcome only when it is still the server's pending session.
   * A connected server keeps that state when the person declined or the previous tokens
   * were written back. Closing a popup never calls this.
   */
  async recordAttemptFailure(input: {
    serverId?: string;
    sessionId: string;
    spaceId: string;
    userId: string;
    kind: "declined" | "failed";
  }): Promise<void> {
    const actor = { spaceId: input.spaceId, userId: input.userId };
    const current = await this.prisma.mcpServer.findFirst({
      where: {
        ...(input.serverId ? { id: input.serverId } : {}),
        ...actor,
        enabled: true,
        pendingOauthSessionId: input.sessionId,
      },
    });
    if (!current || current.pendingOauthSessionId !== input.sessionId) return;
    const declined = input.kind === "declined";
    const kept =
      current.connectionState === "connected" &&
      (await this.restorePriorConnected(current.id, input.sessionId, actor));
    const keepConnection = current.connectionState === "connected" && (declined || kept);
    await this.prisma.mcpServer.updateMany({
      where: {
        id: current.id,
        ...actor,
        enabled: true,
        pendingOauthSessionId: input.sessionId,
      },
      data: {
        connectionState: keepConnection
          ? "connected"
          : current.connectionState === "connected"
            ? "needs-sign-in"
            : declined
              ? "cancelled"
              : "discovery-failed",
        consentStartedAt: null,
        lastError: keepConnection
          ? declined
            ? mcpReauthorizationDeclinedDiagnostic()
            : "Could not complete sign-in. Connect again."
          : current.connectionState === "connected"
            ? mcpSignInDiagnostic()
            : "Could not complete sign-in. Connect again.",
        pendingOauthSessionId: null,
      },
    });
  }

  discardPriorConnected(sessionId: string): void {
    this.priorConnectedMaterial.delete(sessionId);
  }

  /** Put the pre-attempt tokens back. Returns false when this instance has no snapshot. */
  async restorePriorConnected(
    serverId: string,
    sessionId: string,
    context: ActorRef,
  ): Promise<boolean> {
    const prior = this.priorConnectedMaterial.get(sessionId);
    if (!prior?.material.oauth?.tokens) return false;
    const current = await this.prisma.mcpServer.findFirst({
      where: {
        id: serverId,
        ...context,
        enabled: true,
        pendingOauthSessionId: sessionId,
      },
    });
    if (!current || current.pendingOauthSessionId !== sessionId) {
      this.priorConnectedMaterial.delete(sessionId);
      return false;
    }
    const stored = await this.replaceMaterial(
      serverId,
      prior.material,
      context,
      true,
      undefined,
      undefined,
      sessionId,
    );
    this.priorConnectedMaterial.delete(sessionId);
    return stored !== undefined;
  }

  private async refreshMaterial(
    server: ServerRef,
    context: ActorRef,
    previous: OAuthMaterial,
    force: boolean,
  ): Promise<OAuthState> {
    return this.prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${server.id}))`;
          const current = await tx.mcpServer.findFirst({
            where: { id: server.id, ...context, enabled: true, revision: server.revision },
          });
          const row = current?.secretId
            ? await tx.secret.findFirst({ where: { id: current.secretId, ...context } })
            : null;
          if (!current || !row || !server.endpoint) throw new Error("MCP server is unavailable");
          const material = this.read(row.ciphertext, row.id);
          const oauth = material.oauth;
          if (!oauth) throw new McpReauthorizationRequiredError(server.id);
          // Another process may already have rotated the same refresh token.
          if (oauth.tokens?.access_token !== previous.oauth?.tokens?.access_token) return oauth;
          if (
            !force &&
            oauth.tokens?.expires_in &&
            oauth.obtainedAt &&
            Date.now() < oauth.obtainedAt + oauth.tokens.expires_in * 1000 - 60_000
          )
            return oauth;
          const discovery = oauth.discoveryState;
          const network = oauthFetch(server.endpoint, this.network);
          try {
            if (
              !oauth.tokens?.refresh_token ||
              !oauth.clientInformation ||
              !discovery?.authorizationServerUrl
            )
              throw new McpReauthorizationRequiredError(server.id);
            const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
              metadata: discovery.authorizationServerMetadata,
              clientInformation: oauth.clientInformation,
              refreshToken: oauth.tokens.refresh_token,
              resource: new URL(discovery.resourceMetadata?.resource ?? server.endpoint),
              fetchFn: (input, init) =>
                network.fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
            });
            oauth.tokens = {
              ...tokens,
              refresh_token: tokens.refresh_token ?? oauth.tokens.refresh_token,
              ...(tokens.scope || oauth.tokens.scope
                ? { scope: tokens.scope ?? oauth.tokens.scope }
                : {}),
            };
            oauth.obtainedAt = Date.now();
            const stored = await this.secrets.put(JSON.stringify(material), {
              ...context,
              operationId: "mcp.refresh",
              traceId: "mcp.refresh",
              signal: AbortSignal.timeout(15_000),
            });
            await tx.secret.create({ data: { ...stored, ...context, kind: "mcp" } });
            await tx.mcpServer.update({
              where: { id: server.id },
              data: { secretId: stored.id, lastError: null },
            });
            await tx.secret.deleteMany({ where: { id: row.id, ...context } });
            return oauth;
          } catch (error) {
            const reason =
              error &&
              typeof error === "object" &&
              "errorCode" in error &&
              typeof error.errorCode === "string"
                ? error.errorCode
                : "";
            const permanent = [
              "invalid_grant",
              "invalid_client",
              "unauthorized_client",
              "access_denied",
              "invalid_request",
              "invalid_scope",
              "unsupported_grant_type",
              "invalid_token",
              "invalid_target",
            ].includes(reason);
            if (error instanceof McpReauthorizationRequiredError || permanent) {
              // Only a fixed OAuth error code is persisted; provider prose can contain secrets.
              const providerReason = permanent ? reason : "refresh_unavailable";
              delete oauth.tokens;
              const stored = await this.secrets.put(JSON.stringify(material), {
                ...context,
                operationId: "mcp.refresh",
                traceId: "mcp.refresh",
                signal: AbortSignal.timeout(15_000),
              });
              await tx.secret.create({ data: { ...stored, ...context, kind: "mcp" } });
              await tx.mcpServer.update({
                where: { id: server.id },
                data: {
                  secretId: stored.id,
                  connectionState: "needs-sign-in",
                  lastError: mcpSignInDiagnostic(providerReason),
                },
              });
              await tx.secret.deleteMany({ where: { id: row.id, ...context } });
              return { ...oauth, tokens: undefined, failure: providerReason } as OAuthState & {
                failure: string;
              };
            }
            throw error;
          } finally {
            await network.close();
          }
        },
        { timeout: 45_000 },
      )
      .then((value) => {
        if ("failure" in value)
          throw new McpReauthorizationRequiredError(server.id, String(value.failure));
        return value;
      });
  }

  async begin(input: {
    serverId: string;
    spaceId: string;
    userId: string;
    redirectUri: string;
    clientInformation?: OAuthClientInformationMixed;
    sessionId?: string;
  }): Promise<
    | { status: "authorization_required"; sessionId: string; authorizationUrl: string }
    | { status: "already_connected" | "authorization_not_requested" | "replaced" }
  > {
    const server = await this.prisma.mcpServer.findFirst({
      where: {
        id: input.serverId,
        spaceId: input.spaceId,
        userId: input.userId,
        enabled: true,
      },
    });
    if (!server?.endpoint) throw new Error("MCP server endpoint is required for OAuth");
    await this.sweepExpiredPending();
    let actorPending = 0;
    for (const pending of this.pending.values()) {
      if (pending.spaceId === input.spaceId && pending.userId === input.userId) {
        actorPending += 1;
      }
    }
    if (actorPending >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const activeCount = await this.prisma.mcpOAuthSession.count({
      where: { spaceId: input.spaceId, userId: input.userId },
    });
    if (activeCount >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const sessionId = input.sessionId ?? randomUUID();
    const context = { spaceId: input.spaceId, userId: input.userId };
    const loaded = await this.loadMaterial(server, context);
    if (server.catalogId || server.imported)
      loaded.material.oauth = { ...loaded.material.oauth, authorizationRevision: server.revision };
    if (input.clientInformation)
      loaded.material.oauth = {
        ...loaded.material.oauth,
        clientInformation: input.clientInformation,
      };
    let authorizationUrl: URL | undefined;
    const provider = this.createProvider(server, context, loaded, {
      redirectUri: input.redirectUri,
      state: sessionId,
      onAuthorization: (url) => {
        authorizationUrl = url;
      },
    });
    // Never destroy working tokens here: if this attempt fails (network error,
    // cancelled popup), the server keeps its valid connection. The SDK itself
    // invalidates dead tokens when a refresh is rejected with invalid_grant.
    const endpoint = new URL(server.endpoint);
    const networkFetch = oauthFetch(server.endpoint, this.network, loaded.material);
    let challenged = false;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: networkFetch.headers },
      authProvider: provider,
      fetch: async (url, init) => {
        const response = await networkFetch.fetch(url, init);
        if (response.status === 401) challenged = true;
        return response;
      },
    });
    const client = new Client({ name: "ardurbot-oauth", version: "0.1.0" });
    const signal = AbortSignal.timeout(15_000);
    // The caller reserved this session before the probe, so every credential
    // write matches that pending id. A write that loses the reservation is dropped.
    provider.guardTokenWrite(sessionId);
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
    } catch (error) {
      if (isMcpOAuthAttemptReplaced(error)) return { status: "replaced" };
      if (!authorizationUrl) throw challenged ? signInFailure(error, provider) : error;
    } finally {
      await client.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!authorizationUrl) {
      if (provider.tokens()) {
        return { status: "already_connected" };
      }
      return { status: "authorization_not_requested" };
    }
    const sessionMaterial = await this.secrets.put(
      JSON.stringify(loaded.material),
      {
        operationId: "mcp.oauth.session",
        traceId: "mcp.oauth.session",
        spaceId: input.spaceId,
        userId: input.userId,
        botId: "mcp",
        signal: new AbortController().signal,
      },
      sessionId,
    );
    await this.prisma.mcpOAuthSession.create({
      data: {
        id: sessionId,
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: server.endpoint,
        redirectUri: input.redirectUri,
        oauthCiphertext: sessionMaterial.ciphertext,
      },
    });
    const expiry = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.prisma.mcpOAuthSession
        .deleteMany({ where: { id: sessionId } })
        .catch(() => undefined);
    }, PENDING_TTL_MS);
    expiry.unref?.();
    this.pending.set(sessionId, {
      serverId: server.id,
      spaceId: input.spaceId,
      userId: input.userId,
      endpoint: server.endpoint,
      provider,
      createdAt: Date.now(),
      expiry,
    });
    return {
      status: "authorization_required",
      sessionId,
      authorizationUrl: authorizationUrl.toString(),
    };
  }

  async complete(input: {
    sessionId: string;
    code: string;
    state: string;
    spaceId: string;
    userId: string;
  }): Promise<string> {
    await this.sweepExpiredPending();
    if (input.state !== input.sessionId) {
      throw new Error("MCP OAuth session is invalid or expired");
    }
    let pending = this.pending.get(input.sessionId);
    if (pending && (pending.spaceId !== input.spaceId || pending.userId !== input.userId)) {
      pending = undefined;
    }
    if (!pending) {
      const session = await this.prisma.mcpOAuthSession.findFirst({
        where: {
          id: input.sessionId,
          spaceId: input.spaceId,
          userId: input.userId,
          createdAt: { gte: new Date(Date.now() - PENDING_TTL_MS) },
        },
      });
      if (!session) throw new Error("MCP OAuth session is invalid or expired");
      const server = await this.prisma.mcpServer.findFirst({
        where: {
          id: session.serverId,
          spaceId: input.spaceId,
          userId: input.userId,
          enabled: true,
        },
      });
      if (!server?.endpoint) throw new Error("MCP OAuth session is invalid or expired");
      const context = { spaceId: input.spaceId, userId: input.userId };
      const loaded = {
        material: this.read(session.oauthCiphertext, session.id),
        ...(server.secretId ? { secretId: server.secretId } : {}),
      };
      if (
        (server.catalogId || server.imported) &&
        loaded.material.oauth?.authorizationRevision !== server.revision
      )
        throw new Error("MCP OAuth session is invalid or expired");
      pending = {
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: session.endpoint,
        provider: this.createProvider(server, context, loaded, {
          redirectUri: session.redirectUri,
          state: session.id,
        }),
        createdAt: session.createdAt.getTime(),
        expiry: undefined,
      };
    }
    // Consume the session up front so a failed token exchange cannot be
    // retried with a replayed code; the user starts a fresh flow instead.
    this.pending.delete(input.sessionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    const consumed = await this.prisma.mcpOAuthSession.deleteMany({
      where: {
        id: input.sessionId,
        spaceId: input.spaceId,
        userId: input.userId,
      },
    });
    if (consumed.count !== 1) throw new Error("MCP OAuth session is invalid or expired");
    const context = { spaceId: input.spaceId, userId: input.userId };
    const current = await this.prisma.mcpServer.findFirst({
      where: { id: pending.serverId, ...context, enabled: true },
    });
    // Null and a different id are the same outcome: this attempt is not the one
    // still pending, so the code is not exchanged and no tokens are written.
    if (!current) throw new Error("MCP OAuth session is invalid or expired");
    if (current.pendingOauthSessionId !== input.sessionId) {
      throw new McpOAuthAttemptReplacedError();
    }
    if (current?.connectionState === "connected" && current.secretId && current.endpoint) {
      const loaded = await this.loadMaterial(
        {
          id: pending.serverId,
          endpoint: current.endpoint,
          secretId: current.secretId,
          revision: current.revision,
        },
        context,
      );
      if (loaded.material.oauth?.tokens) {
        this.priorConnectedMaterial.set(input.sessionId, {
          at: Date.now(),
          material: structuredClone(loaded.material),
        });
      }
    }
    pending.provider.guardTokenWrite(input.sessionId);
    const endpoint = new URL(pending.endpoint);
    const networkFetch = oauthFetch(pending.endpoint, this.network);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: pending.provider,
      fetch: networkFetch.fetch,
    });
    try {
      await transport.finishAuth(input.code);
    } finally {
      await transport.close().catch(() => undefined);
      await networkFetch.close().catch(() => undefined);
    }
    if (!pending.provider.tokens()) throw new Error("MCP OAuth authorization failed");
    // Token commit rebuilds cached sessions. It does not record the attempt:
    // connectionState and the pending session id stay until discovery finishes.
    const serverId = pending.serverId;
    await this.prisma.$transaction(async (tx) => {
      await this.lockMaterial(tx, serverId, context, true);
      if (!(await bumpMcpServerRevision(tx, serverId, context)))
        throw new Error("MCP OAuth session is invalid or expired");
    });
    return pending.serverId;
  }

  private async sweepExpiredPending(): Promise<void> {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [sessionId, prior] of this.priorConnectedMaterial) {
      if (prior.at < cutoff) this.priorConnectedMaterial.delete(sessionId);
    }
    for (const [sessionId, pending] of this.pending) {
      if (pending.createdAt < cutoff) {
        this.discardPending(sessionId, pending);
      }
    }
    await this.prisma.mcpOAuthSession.deleteMany({
      where: { createdAt: { lt: new Date(cutoff) } },
    });
  }

  private discardPending(sessionId: string, pending: Pending): void {
    if (pending.expiry) clearTimeout(pending.expiry);
    this.pending.delete(sessionId);
  }

  discardSession(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (pending) this.discardPending(sessionId, pending);
  }

  forgetPending(input: { serverId: string; spaceId: string; userId: string }): void {
    for (const [id, pending] of this.pending) {
      if (
        pending.serverId === input.serverId &&
        pending.spaceId === input.spaceId &&
        pending.userId === input.userId
      )
        this.discardPending(id, pending);
    }
  }

  async disconnect(input: { serverId: string; spaceId: string; userId: string }): Promise<void> {
    for (const [id, pending] of this.pending) {
      if (
        pending.serverId === input.serverId &&
        pending.spaceId === input.spaceId &&
        pending.userId === input.userId
      )
        this.discardPending(id, pending);
    }
    await this.prisma.mcpOAuthSession.deleteMany({
      where: { serverId: input.serverId, spaceId: input.spaceId, userId: input.userId },
    });
    const server = await this.prisma.mcpServer.findFirst({
      where: { id: input.serverId, spaceId: input.spaceId, userId: input.userId },
    });
    if (server?.secretId) {
      const row = await this.prisma.secret.findFirst({
        where: { id: server.secretId, spaceId: input.spaceId, userId: input.userId },
      });
      if (row) {
        const material = this.read(row.ciphertext, row.id);
        delete material.oauth;
        await this.replaceMaterial(server.id, material, input, true);
      }
    }
    // An in-flight sign-in attempt for this server can no longer complete. Cleared only
    // after the credential material above is gone, so no poll in between sees a
    // connected server with no pending id. Compares against the id this call observed,
    // the way claimSignIn/releaseAttempt do, so a newer id claimed in the gap survives.
    if (server?.pendingOauthSessionId) {
      await this.prisma.mcpServer.updateMany({
        where: {
          id: input.serverId,
          spaceId: input.spaceId,
          userId: input.userId,
          pendingOauthSessionId: server.pendingOauthSessionId,
        },
        data: { pendingOauthSessionId: null },
      });
    }
  }

  private async loadMaterial(
    server: ServerRef,
    context: ActorRef,
  ): Promise<{ material: OAuthMaterial; secretId?: string }> {
    if (!server.secretId) return { material: {} };
    const row = await this.prisma.secret.findFirst({
      where: { id: server.secretId, spaceId: context.spaceId, userId: context.userId },
    });
    return row
      ? { material: this.read(row.ciphertext, row.id), secretId: row.id }
      : { material: {} };
  }

  private createProvider(
    server: ServerRef,
    context: ActorRef,
    loaded: { material: OAuthMaterial; secretId?: string },
    options: ProviderOptions = {},
  ): StoredMcpOAuthProvider {
    return new StoredMcpOAuthProvider(
      server.id,
      loaded.material,
      async (material, pendingSessionId) => {
        const stored = await this.replaceMaterial(
          server.id,
          material,
          context,
          false,
          server.endpoint,
          server.catalogId || server.imported ? server.revision : undefined,
          pendingSessionId,
        );
        if (pendingSessionId !== undefined && stored === undefined) {
          throw new McpOAuthAttemptReplacedError();
        }
      },
      options,
    );
  }

  private async replaceMaterial(
    serverId: string,
    material: OAuthMaterial,
    context: ActorRef,
    incrementRevision: boolean,
    expectedEndpoint?: string | null,
    expectedRevision?: number,
    expectedPendingSessionId?: string,
  ): Promise<string | undefined> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize every credential rotation across API instances. OAuth
      // providers hold a session snapshot, so merge only their OAuth state
      // into the latest static material after acquiring the lock.
      await this.lockMaterial(tx, serverId, context, incrementRevision);
      const server = await tx.mcpServer.findFirst({
        where: {
          id: serverId,
          spaceId: context.spaceId,
          userId: context.userId,
          // A sign-in attempt's writes are guarded by its pending id alone: only a newer
          // attempt takes that id, so a grant save or a disabled row never drops them.
          ...(expectedPendingSessionId !== undefined
            ? { pendingOauthSessionId: expectedPendingSessionId }
            : {
                ...(expectedEndpoint !== undefined ? { enabled: true } : {}),
                ...(expectedRevision !== undefined ? { revision: expectedRevision } : {}),
              }),
        },
        select: { endpoint: true, secretId: true },
      });
      if (!server) {
        if (expectedPendingSessionId !== undefined) return undefined;
        throw new Error("MCP server is unavailable");
      }
      if (expectedEndpoint !== undefined && server.endpoint !== expectedEndpoint) {
        throw new Error("MCP server endpoint changed during authorization; reconnect this server");
      }
      const currentSecret = server.secretId
        ? await tx.secret.findFirst({
            where: {
              id: server.secretId,
              spaceId: context.spaceId,
              userId: context.userId,
            },
          })
        : null;
      const nextMaterial = currentSecret
        ? this.read(currentSecret.ciphertext, currentSecret.id)
        : {};
      if (material.oauth) nextMaterial.oauth = structuredClone(material.oauth);
      else delete nextMaterial.oauth;
      const hasMaterial = Boolean(
        nextMaterial.secret ||
          Object.keys(nextMaterial.env ?? {}).length ||
          Object.keys(nextMaterial.headers ?? {}).length ||
          nextMaterial.oauth,
      );
      const stored = hasMaterial
        ? await this.secrets.put(JSON.stringify(nextMaterial), {
            operationId: "mcp.oauth.persist",
            traceId: "mcp.oauth.persist",
            spaceId: context.spaceId,
            userId: context.userId,
            botId: "mcp",
            signal: new AbortController().signal,
          })
        : undefined;
      if (stored) {
        await tx.secret.create({
          data: {
            id: stored.id,
            spaceId: context.spaceId,
            userId: context.userId,
            kind: "mcp",
            ciphertext: stored.ciphertext,
          },
        });
      }
      const previousSecretId = server.secretId;
      const secretData = { secretId: stored?.id ?? null };
      let saved = true;
      if (incrementRevision) {
        saved = await bumpMcpServerRevision(
          tx,
          serverId,
          context,
          secretData,
          expectedPendingSessionId !== undefined
            ? { pendingOauthSessionId: expectedPendingSessionId }
            : {},
        );
      } else if (expectedPendingSessionId !== undefined) {
        const written = await tx.mcpServer.updateMany({
          where: {
            id: serverId,
            spaceId: context.spaceId,
            userId: context.userId,
            pendingOauthSessionId: expectedPendingSessionId,
          },
          data: secretData,
        });
        saved = written.count > 0;
      } else {
        await tx.mcpServer.update({ where: { id: serverId }, data: secretData });
      }
      if (!saved) {
        if (stored) {
          await tx.secret.deleteMany({
            where: { id: stored.id, spaceId: context.spaceId, userId: context.userId },
          });
        }
        if (expectedPendingSessionId !== undefined) return undefined;
        throw new Error("MCP server is unavailable");
      }
      if (previousSecretId && previousSecretId !== stored?.id) {
        await tx.secret.deleteMany({ where: { id: previousSecretId } });
      }
      return stored?.id;
    });
  }

  private async lockMaterial(
    tx: Prisma.TransactionClient,
    serverId: string,
    context: ActorRef,
    incrementRevision: boolean,
  ) {
    if (incrementRevision) await lockMcpServerRevision(tx, serverId, context);
    else
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${serverId}))`;
  }

  private read(ciphertext: string, recordId: string): OAuthMaterial {
    try {
      const value = JSON.parse(this.secrets.load(ciphertext, recordId));
      return value && typeof value === "object" ? (value as OAuthMaterial) : {};
    } catch {
      return {};
    }
  }
}
