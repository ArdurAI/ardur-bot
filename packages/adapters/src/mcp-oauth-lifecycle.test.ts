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
async function fixture(response: () => Promise<Response>) {
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
    catalogId: "notion",
    connectionState: "connected",
  };
  let lock = Promise.resolve();
  const db = {
    mcpServer: {
      findFirst: vi.fn(async () => ({ ...server })),
      update: vi.fn(async ({ data }) => {
        server = { ...server, ...data };
        return server;
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
    mcpOAuthSession: { findFirst: vi.fn() },
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
    db,
    fetch,
    provider,
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
});
