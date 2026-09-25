import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthMaterial, StoredMcpOAuthProvider } from "./mcp-oauth.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { EncryptedSecretStore } from "./secrets.js";

afterEach(() => vi.restoreAllMocks());
const actor = { userId: "owner", spaceId: "space" };
function material(): OAuthMaterial {
  return {
    oauth: {
      obtainedAt: Date.now() - 3600_000,
      tokens: {
        access_token: "fake-old-access",
        refresh_token: "fake-old-refresh",
        token_type: "bearer",
        expires_in: 3600,
      },
      clientInformation: { client_id: "fake-client" },
      discoveryState: {
        authorizationServerUrl: "https://auth.example.test",
        authorizationServerMetadata: {
          issuer: "https://auth.example.test",
          token_endpoint: "https://auth.example.test/token",
          authorization_endpoint: "https://auth.example.test/authorize",
          response_types_supported: ["code"],
        },
      },
    },
  };
}
async function fixture(
  response: () => Promise<Response>,
  overrides: {
    catalogId?: string | null;
    connectionState?: string;
    pendingOauthSessionId?: string | null;
  } = {},
) {
  const secrets = new EncryptedSecretStore(randomBytes(32).toString("hex"));
  const context = {
    ...actor,
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const initial = await secrets.put(JSON.stringify(material()), context);
  const rows = new Map([[initial.id, initial]]);
  let server = {
    id: "connection",
    ...actor,
    endpoint: "https://mcp.example.test/mcp",
    revision: 1,
    enabled: true,
    secretId: initial.id,
    catalogId: "notion" as string | null,
    connectionState: "connected",
    pendingOauthSessionId: null as string | null,
    lastError: null as string | null,
    ...overrides,
  };
  let lock = Promise.resolve();
  const db = {
    mcpServer: {
      findFirst: vi.fn(async () => ({ ...server })),
      update: vi.fn(async ({ data }) => {
        const revision =
          data.revision && typeof data.revision === "object" && "increment" in data.revision
            ? server.revision + Number(data.revision.increment)
            : server.revision;
        const { revision: _revision, ...rest } = data;
        server = { ...server, ...rest, ...(data.revision ? { revision } : {}) };
        return server;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const matches = Object.entries(where).every(
          ([key, value]) => server[key as keyof typeof server] === value,
        );
        if (!matches) return { count: 0 };
        const revision =
          data.revision && typeof data.revision === "object" && "increment" in data.revision
            ? server.revision + Number(data.revision.increment)
            : server.revision;
        const { revision: _revision, ...rest } = data;
        server = { ...server, ...rest, ...(data.revision ? { revision } : {}) };
        return { count: 1 };
      }),
    },
    secret: {
      findFirst: vi.fn(async ({ where }) => rows.get(where.id)),
      create: vi.fn(async ({ data }) => {
        rows.set(data.id, data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }) => {
        rows.delete(where.id);
        return { count: 1 };
      }),
    },
    mcpOAuthSession: { findFirst: vi.fn(), deleteMany: vi.fn(async () => ({ count: 1 })) },
    $executeRaw: vi.fn(),
    $transaction: vi.fn((fn) => {
      const next = lock.then(() => fn(db));
      lock = next.catch(() => undefined);
      return next;
    }),
  };
  const fetch = vi.fn(response);
  const broker = new McpOAuthBroker(db as never, secrets, {
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  const provider = async () => (await broker.providerFor(server, actor)) as StoredMcpOAuthProvider;
  return {
    broker,
    context,
    db,
    fetch,
    provider,
    secrets,
    server: () => server,
    persisted: () =>
      JSON.parse(
        secrets.load(rows.get(server.secretId)!.ciphertext, server.secretId),
      ) as OAuthMaterial,
    rows,
  };
}

describe("managed OAuth lifecycle", () => {
  it("refreshes before expiry, persists rotated credentials encrypted, and retains an omitted refresh token", async () => {
    const f = await fixture(async () =>
      Response.json({ access_token: "fake-fresh-access", token_type: "bearer", expires_in: 3600 }),
    );
    const provider = await f.provider();
    await provider.prepareTokens();
    expect(provider.tokens()).toMatchObject({
      access_token: "fake-fresh-access",
      refresh_token: "fake-old-refresh",
    });
    expect(f.persisted().oauth?.tokens?.access_token).toBe("fake-fresh-access");
    expect(JSON.stringify([...f.rows.values()])).not.toContain("fake-fresh-access");
    await provider.prepareTokens();
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("serializes refresh across concurrent providers and rotates a single-use refresh token once", async () => {
    const f = await fixture(async () =>
      Response.json({
        access_token: "fake-fresh-access",
        refresh_token: "fake-next-refresh",
        token_type: "bearer",
        expires_in: 3600,
      }),
    );
    const a = await f.provider();
    const b = await f.provider();
    await Promise.all([a.prepareTokens(), b.prepareTokens()]);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(a.tokens()).toEqual(b.tokens());
  });
  it("keeps connected state and tokens after a transient token endpoint failure", async () => {
    const f = await fixture(async () => {
      throw new TypeError("fake-network-response");
    });
    const provider = await f.provider();
    await expect(provider.prepareTokens()).rejects.toThrow();
    expect(f.server().connectionState).toBe("connected");
    expect(f.persisted().oauth?.tokens?.refresh_token).toBe("fake-old-refresh");
    expect(f.db.mcpServer.update).not.toHaveBeenCalled();
  });
  it("commits Needs sign-in only after refresh is rejected, retaining the safe OAuth reason", async () => {
    const f = await fixture(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "fake-secret-response" },
        { status: 400 },
      ),
    );
    await expect((await f.provider()).prepareTokens()).rejects.toThrow("invalid_grant");
    expect(f.server()).toMatchObject({
      connectionState: "needs-sign-in",
      lastError: "Needs sign-in (invalid_grant).",
    });
    expect(f.persisted().oauth?.tokens).toBeUndefined();
    expect(JSON.stringify(f.server())).not.toContain("fake-secret-response");
    expect(await f.broker.statusFor(f.server(), actor)).toBe("reconnect");
  });
  it("resolves callback ownership from the persisted state instead of the browser's cookies", async () => {
    const f = await fixture(async () => Response.json({}));
    f.db.mcpOAuthSession.findFirst.mockResolvedValue({
      id: "state",
      ...actor,
      serverId: "connection",
    });
    const complete = vi.spyOn(f.broker, "complete").mockResolvedValue("connection");
    expect(await f.broker.completeRedirect({ state: "state", code: "fake-code" })).toEqual({
      ...actor,
      serverId: "connection",
    });
    expect(complete).toHaveBeenCalledWith({
      ...actor,
      state: "state",
      sessionId: "state",
      code: "fake-code",
    });
    f.db.mcpOAuthSession.findFirst.mockResolvedValue(null);
    await expect(
      f.broker.completeRedirect({ state: "missing", code: "fake-code" }),
    ).rejects.toThrow("expired");
  });
  it.each([
    ["declines", { error: "access_denied" }, "cancelled"],
    ["fails", { code: "fake-code" }, "discovery-failed"],
  ])("records the outcome when a custom server's sign-in %s", async (_, callback, state) => {
    const f = await fixture(async () => Response.json({}), {
      catalogId: null,
      connectionState: "not-connected",
      pendingOauthSessionId: "state",
    });
    const pending = await f.secrets.put("{}", f.context, "state");
    f.db.mcpOAuthSession.findFirst.mockResolvedValue({
      id: "state",
      ...actor,
      serverId: "connection",
      oauthCiphertext: pending.ciphertext,
    });
    vi.spyOn(f.broker, "complete").mockRejectedValue(new Error("fake-token-exchange"));
    await expect(f.broker.completeRedirect({ state: "state", ...callback })).rejects.toThrow(
      "sign-in failed",
    );
    expect(f.server()).toMatchObject({
      connectionState: state,
      lastError: "Could not complete sign-in. Connect again.",
      pendingOauthSessionId: null,
    });
  });
  it("ignores a late decline after a newer sign-in replaced the window", async () => {
    const f = await fixture(async () => Response.json({}), {
      catalogId: null,
      connectionState: "not-connected",
      pendingOauthSessionId: "newer",
    });
    const pending = await f.secrets.put("{}", f.context, "state");
    f.db.mcpOAuthSession.findFirst.mockResolvedValue({
      id: "state",
      ...actor,
      serverId: "connection",
      oauthCiphertext: pending.ciphertext,
    });
    await expect(
      f.broker.completeRedirect({ state: "state", error: "access_denied" }),
    ).rejects.toThrow("sign-in failed");
    expect(f.server()).toMatchObject({
      connectionState: "not-connected",
      pendingOauthSessionId: "newer",
    });
    expect(f.server().lastError).toBeNull();
  });
  it("keeps the finished sign-in's tokens when an older callback arrives", async () => {
    const f = await fixture(
      async () =>
        Response.json({ access_token: "fake-a-access", token_type: "bearer", expires_in: 3600 }),
      { catalogId: null, connectionState: "connected", pendingOauthSessionId: null },
    );
    const sessionMaterial = material();
    sessionMaterial.oauth!.codeVerifier = "fake-verifier";
    const stored = await f.secrets.put(JSON.stringify(sessionMaterial), f.context, "attempt-a");
    f.db.mcpOAuthSession.findFirst.mockResolvedValue({
      id: "attempt-a",
      ...actor,
      serverId: "connection",
      endpoint: "https://mcp.example.test/mcp",
      redirectUri: "https://app.example.test/api/oauth/done",
      oauthCiphertext: stored.ciphertext,
      createdAt: new Date(),
    });
    const writesBefore = f.db.secret.create.mock.calls.length;
    await expect(
      f.broker.complete({
        sessionId: "attempt-a",
        code: "fake-code-a",
        state: "attempt-a",
        ...actor,
      }),
    ).rejects.toThrow("replaced");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.db.secret.create).toHaveBeenCalledTimes(writesBefore);
    expect(f.persisted().oauth?.tokens?.access_token).toBe("fake-old-access");
    expect(f.server().pendingOauthSessionId).toBeNull();
  });
  it("writes the previous tokens back when a re-authorization fails on this instance", async () => {
    const f = await fixture(async () => Response.json({}), {
      catalogId: null,
      connectionState: "connected",
      pendingOauthSessionId: "state",
    });
    const replaced = await f.secrets.put(
      JSON.stringify({
        oauth: {
          ...material().oauth,
          tokens: { ...material().oauth!.tokens!, access_token: "fake-new-access" },
        },
      }),
      f.context,
    );
    f.rows.set(replaced.id, replaced);
    f.server().secretId = replaced.id;
    (
      f.broker as unknown as {
        priorConnectedMaterial: Map<string, { at: number; material: OAuthMaterial }>;
      }
    ).priorConnectedMaterial.set("state", { at: Date.now(), material: material() });
    await f.broker.recordAttemptFailure({
      serverId: "connection",
      sessionId: "state",
      ...actor,
      kind: "failed",
    });
    expect(f.persisted().oauth?.tokens?.access_token).toBe("fake-old-access");
    expect(f.server()).toMatchObject({
      connectionState: "connected",
      pendingOauthSessionId: null,
      lastError: "Could not complete sign-in. Connect again.",
    });
  });
});
