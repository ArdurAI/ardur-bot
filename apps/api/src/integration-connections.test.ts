import { randomBytes } from "node:crypto";
import {
  captureIntegrationManifest,
  EncryptedSecretStore,
  McpConnector,
  McpReauthorizationRequiredError,
} from "@ardurbot/adapters";
import type { McpServer } from "@ardurbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSession } from "../../../packages/adapters/src/mcp-transport.js";
import { IntegrationConnections, needsClientRegistration } from "./integration-connections.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const actor = { spaceId: "space", userId: "owner" };
const manifest = captureIntegrationManifest(
  [
    {
      name: "synthetic_read",
      description: "Synthetic test fixture, not a vendor tool",
      inputSchema: { type: "object" },
    },
  ],
  "synthetic-1",
);

function fixture(stdio: { stdioEnabled?: boolean; allowedCommands?: string[] } = {}) {
  let row = {
    id: "connection",
    ...actor,
    catalogId: "github",
    slug: "catalog-github-test",
    name: "GitHub",
    transport: "streamable_http",
    endpoint: "https://api.githubcopilot.com/mcp/",
    enabled: true,
    revision: 1,
    secretId: null,
    connectionState: "connected",
    manifest,
    spaceAllowedTools: [],
    spaceToolPolicies: {},
  } as unknown as McpServer;
  let grants: Array<{
    botId: string;
    serverId: string;
    allowedTools: string[];
    allowAllTools: boolean;
    needsReview: boolean;
  }> = [];
  const mcpServer = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (
        where.id !== row.id ||
        where.spaceId !== row.spaceId ||
        where.userId !== row.userId ||
        (where.enabled === true && !row.enabled)
      )
        return null;
      return { ...row };
    }),
    findMany: vi.fn(async () => [{ ...row, assignments: grants }]),
    create: vi.fn(async ({ data }: { data: Partial<McpServer> }) => {
      row = { ...row, manifest: null, connectionState: "awaiting-consent", ...data };
      return { ...row };
    }),
    update: vi.fn(async ({ data }: { data: Partial<McpServer> }) => {
      const revision = typeof data.revision === "object" ? row.revision + 1 : row.revision;
      row = { ...row, ...data, revision };
      return { ...row };
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { revision: number }; data: Partial<McpServer> }) => {
        if (row.revision !== where.revision || !row.enabled) return { count: 0 };
        const revision = typeof data.revision === "object" ? row.revision + 1 : row.revision;
        row = { ...row, ...data, revision };
        return { count: 1 };
      },
    ),
  };
  const secretRows = new Map<string, { id: string; ciphertext: string }>();
  const secretStore = new EncryptedSecretStore(randomBytes(32).toString("hex"));
  const db = {
    secret: {
      create: vi.fn(async ({ data }) => {
        secretRows.set(data.id, data);
        return data;
      }),
      findFirst: vi.fn(async ({ where }) => secretRows.get(where.id) ?? null),
      deleteMany: vi.fn(async ({ where }) => {
        secretRows.delete(where.id);
        return { count: 1 };
      }),
    },
    mcpServer,
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    bot: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => id === "bot").map((id) => ({ id })),
      ),
    },
    botMcpServer: {
      updateMany: vi.fn(async ({ data }: { data: Partial<(typeof grants)[number]> }) => {
        grants = grants.map((grant) => ({ ...grant, ...data }));
        return { count: grants.length };
      }),
      findMany: vi.fn(async () => grants),
      deleteMany: vi.fn(async () => {
        grants = [];
        return { count: 1 };
      }),
      createMany: vi.fn(async ({ data }: { data: typeof grants }) => {
        grants = data;
        return { count: data.length };
      }),
    },
    mcpOAuthSession: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    externalEffect: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (callback) => callback(db));
  const oauth = {
    begin: vi.fn(async (_input: unknown) => ({
      status: "authorization_required",
      sessionId: "session",
      authorizationUrl: "https://example.test/authorize",
    })),
    disconnect: vi.fn(async () => undefined),
    forgetPending: vi.fn(),
  };
  const service = new IntegrationConnections(
    db as never,
    oauth as never,
    secretStore,
    "https://app.example.test",
    { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    stdio,
  );
  return {
    service,
    secretStore,
    secretRows,
    db,
    oauth,
    row: () => row,
    setRow: (patch: Partial<McpServer>) => {
      Object.assign(row, patch);
    },
  };
}

describe("catalog connection lifecycle", () => {
  it.each([null, "extension", "plugin"])(
    "persists custom MCP permissions atomically for %s provenance",
    async (managedBy) => {
      const f = fixture();
      f.setRow({ catalogId: null, managedBy });
      const input = {
        connectionId: "connection",
        botIds: ["bot"],
        toolIds: ["synthetic_read"],
        spaceToolPolicies: { synthetic_read: "allow" as const },
      };
      await f.service.assign(actor, input, "mcp");
      expect(f.row().spaceToolPolicies).toEqual({ synthetic_read: "allow" });
      expect(await f.service.grants(actor, "connection")).toEqual([
        expect.objectContaining({ botId: "bot", toolIds: ["synthetic_read"] }),
      ]);
      await f.service.assign(
        actor,
        { ...input, spaceToolPolicies: { synthetic_read: "ask-first" } },
        "mcp",
      );
      expect(f.row().spaceToolPolicies).toEqual({ synthetic_read: "ask-first" });
      await f.service.assign(
        actor,
        { ...input, toolIds: [], spaceToolPolicies: { synthetic_read: "ask-first" } },
        "mcp",
      );
      expect((await f.service.grants(actor, "connection"))[0]?.toolIds).toEqual([]);
      expect(f.db.externalEffect.updateMany).toHaveBeenCalledTimes(3);
    },
  );
  it("invalidates custom MCP grants when a captured tool schema changes", async () => {
    const f = fixture();
    f.setRow({ catalogId: null });
    await f.service.assign(
      actor,
      { connectionId: "connection", botIds: ["bot"], toolIds: ["synthetic_read"] },
      "mcp",
    );
    vi.spyOn(f.service, "tools").mockResolvedValue({
      ...manifest,
      tools: manifest.tools.map((tool) => ({ ...tool, inputSchemaDigest: "b".repeat(64) })),
    });
    await f.service.capture(actor, "connection");
    expect(await f.service.grants(actor, "connection")).toEqual([
      expect.objectContaining({ needsReview: true, toolIds: [] }),
    ]);
    expect(f.row().spaceToolPolicies).toEqual({});
  });
  it("keeps catalog and MCP permission mutations in their owning sections", async () => {
    const f = fixture();
    const input = { connectionId: "connection", botIds: [], toolIds: [] };
    await expect(f.service.assign(actor, input, "mcp")).rejects.toThrow();
    f.setRow({ catalogId: null });
    await expect(f.service.assign(actor, input)).rejects.toThrow();
  });
  it.each(["authorization_not_requested", "already_connected"] as const)(
    "discovers custom servers after an OAuth probe returns %s",
    async (status) => {
      const f = fixture();
      f.setRow({ catalogId: null, connectionState: "not-connected" });
      f.oauth.begin.mockResolvedValue({ status } as never);
      vi.spyOn(f.service, "tools").mockResolvedValue(manifest);
      const input = {
        serverId: "connection",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      };
      expect(await f.service.beginAuthorization(actor, input)).toEqual({ status });
      expect(f.oauth.begin).toHaveBeenCalledWith({ ...input, ...actor });
      expect(f.service.tools).toHaveBeenCalledWith(actor, "connection");
      expect(f.row()).toMatchObject({ connectionState: "connected", manifest });
    },
  );
  it("waits for OAuth consent before discovering a custom server", async () => {
    const f = fixture();
    const tools = vi.spyOn(f.service, "tools");
    expect(
      await f.service.beginAuthorization(actor, {
        serverId: "connection",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
      }),
    ).toMatchObject({ status: "authorization_required" });
    expect(tools).not.toHaveBeenCalled();
    await expect(
      f.service.beginAuthorization(
        { ...actor, userId: "other" },
        {
          serverId: "connection",
          redirectUri: "https://app.example.test/mcp/oauth/callback",
        },
      ),
    ).rejects.toThrow();
    expect(f.oauth.begin).toHaveBeenCalledTimes(1);
  });
  it.each(["notion", "atlassian"])(
    "connects, cancels, reconnects and revokes %s with an enriched actor",
    async (catalogId) => {
      const f = fixture();
      const owner = { ...actor, isDeploymentOwner: true, role: "owner" };
      const first = await f.service.connect(owner, { catalogId });
      expect(first.authorizationUrl).toBe("https://example.test/authorize");
      await f.service.revoke(owner, first.connection.id, "cancelled");
      expect(f.row().connectionState).toBe("cancelled");
      const next = await f.service.connect(owner, { catalogId, connectionId: first.connection.id });
      expect(next.authorizationUrl).toBe("https://example.test/authorize");
      await f.service.revoke(owner, next.connection.id);
      expect(f.row().connectionState).toBe("not-connected");
      for (const [{ where }] of f.db.mcpServer.findFirst.mock.calls) {
        expect(where).not.toHaveProperty("isDeploymentOwner");
        expect(where).not.toHaveProperty("role");
        expect(where).toMatchObject(actor);
      }
    },
  );
  it("keeps actor metadata out of token connection filters and secret rows", async () => {
    const f = fixture();
    const owner = { ...actor, isDeploymentOwner: true };
    vi.spyOn(McpConnector.prototype, "inspectServer").mockResolvedValue(manifest);
    const result = await f.service.connect(owner, { catalogId: "github", token: "test-token" });
    expect(result.connection.state).toBe("connected");
    await f.service.revoke(owner, result.connection.id);
    for (const [{ where }] of f.db.mcpServer.findFirst.mock.calls)
      expect(where).not.toHaveProperty("isDeploymentOwner");
    expect(f.db.secret.create.mock.calls[0]![0].data).not.toHaveProperty("isDeploymentOwner");
    expect(f.db.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), ...actor },
    });
  });
  it("creates an unassigned connection and delegates OAuth without inventing client parameters", async () => {
    const f = fixture();
    const result = await f.service.connect(actor, { catalogId: "gitlab" });
    expect(f.db.mcpServer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogId: "gitlab",
        endpoint: "https://gitlab.com/api/v4/mcp",
        transport: "streamable_http",
      }),
    });
    expect(f.db.botMcpServer.createMany).not.toHaveBeenCalled();
    expect(f.oauth.begin).toHaveBeenCalledWith({
      serverId: result.connection.id,
      ...actor,
      redirectUri: "https://app.example.test/api/oauth/done",
    });
    expect(result.connection.state).toBe("awaiting-consent");
    expect(result.authorizationUrl).toBe("https://example.test/authorize");
  });
  it.each(["jenkins", "kubernetes", "google-cloud", "azure", "unknown"])(
    "refuses unavailable %s before creating a connection",
    async (catalogId) => {
      const f = fixture();
      await expect(f.service.connect(actor, { catalogId })).rejects.toThrow();
      expect(f.db.mcpServer.create).not.toHaveBeenCalled();
      expect(f.oauth.begin).not.toHaveBeenCalled();
    },
  );
  it("reports client registration needs and redacts other provider failures", async () => {
    const f = fixture();
    f.oauth.begin.mockRejectedValueOnce(
      new Error("Incompatible auth server: does not support dynamic client registration"),
    );
    expect((await f.service.connect(actor, { catalogId: "notion" })).connection.state).toBe(
      "needs-client-registration",
    );
    f.oauth.begin.mockRejectedValueOnce(new Error("Bearer fake-secret"));
    const failed = await f.service.connect(actor, { catalogId: "notion" });
    expect(failed.connection.state).toBe("discovery-failed");
    expect(JSON.stringify(failed)).not.toContain("fake-secret");
    expect(needsClientRegistration(new Error("network failed"))).toBe(false);
  });
  it("stores encrypted token material, discovers before Connected, and revokes it with grants", async () => {
    const f = fixture();
    const token = randomBytes(24).toString("hex");
    vi.spyOn(McpConnector.prototype, "inspectServer").mockImplementation(async (server) => {
      const stored = f.secretRows.get(server.secretId!)!;
      expect(stored.ciphertext).not.toContain(token);
      expect(JSON.parse(f.secretStore.load(stored.ciphertext, stored.id))).toEqual({
        secret: token,
      });
      return manifest;
    });
    const result = await f.service.connect(actor, { catalogId: "github", token });
    expect(result.connection.state).toBe("connected");
    expect(f.oauth.begin).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(await f.service.list(actor))).not.toContain(token);
    await f.service.assign(actor, {
      connectionId: result.connection.id,
      botIds: ["bot"],
      toolIds: ["synthetic_read"],
    });
    await f.service.revoke(actor, result.connection.id);
    expect(f.row().secretId).toBeNull();
    expect(f.secretRows.size).toBe(0);
    expect(await f.service.grants(actor, result.connection.id)).toEqual([]);
  });
  it("reports a bad token only as discovery-failed", async () => {
    const f = fixture();
    const token = randomBytes(24).toString("hex");
    vi.spyOn(McpConnector.prototype, "inspectServer").mockRejectedValue(new Error(token));
    const result = await f.service.connect(actor, { catalogId: "github", token });
    expect(result.connection.state).toBe("discovery-failed");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.connection.manifest).toBeNull();
  });
  it("advertises configured OAuth without returning client values and rejects missing app configuration", async () => {
    vi.stubEnv("GITHUB_MCP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_MCP_CLIENT_SECRET", "");
    const f = fixture();
    expect(
      (await f.service.list(actor)).catalog.find((d) => d.id === "github")?.oauthAvailable,
    ).toBe(false);
    await expect(
      f.service.connect(actor, { catalogId: "github", authKind: "oauth" }),
    ).rejects.toThrow("not configured");
    const client = randomBytes(12).toString("hex");
    const secret = randomBytes(24).toString("hex");
    vi.stubEnv("GITHUB_MCP_CLIENT_ID", client);
    vi.stubEnv("GITHUB_MCP_CLIENT_SECRET", secret);
    const listed = await f.service.list(actor);
    expect(listed.catalog.find((d) => d.id === "github")?.oauthAvailable).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(listed)).not.toContain(client);
    await f.service.connect(actor, { catalogId: "github", authKind: "oauth" });
    expect(f.oauth.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        clientInformation: {
          client_id: client,
          client_secret: secret,
          token_endpoint_auth_method: "client_secret_post",
        },
      }),
    );
  });
  it("persists resource constraints with a new revision and invalidates earlier approvals", async () => {
    const f = fixture();
    f.setRow({ catalogId: "atlassian" });
    const resourceConstraints = { jiraProjects: ["DEMO"], confluenceSpaces: ["DOCS"] };
    await f.service.assign(actor, {
      connectionId: "connection",
      botIds: [],
      toolIds: [],
      resourceConstraints,
    });
    expect(f.row().resourceConstraints).toEqual(resourceConstraints);
    expect((await f.service.list(actor)).connections[0]?.resourceConstraints).toEqual(
      resourceConstraints,
    );
    expect(f.row().revision).toBe(2);
    expect(f.db.externalEffect.updateMany).toHaveBeenCalled();
    await expect(
      f.service.assign(actor, {
        connectionId: "connection",
        botIds: [],
        toolIds: [],
        resourceConstraints: { jiraProjects: ["bad key"] },
      }),
    ).rejects.toThrow();
  });
  it("keeps custom stdio discovery behind the configured executable allowlist", async () => {
    const connect = vi.spyOn(McpSession.prototype, "connectStdio").mockResolvedValue();
    vi.spyOn(McpSession.prototype, "listTools").mockResolvedValue({ tools: [] });
    const disabled = fixture();
    disabled.setRow({ catalogId: null, transport: "stdio", command: "/synthetic/server" });
    await expect(disabled.service.tools(actor, "connection")).rejects.toThrow("disabled");
    expect(connect).not.toHaveBeenCalled();
    const enabled = fixture({ stdioEnabled: true, allowedCommands: ["/synthetic/server"] });
    enabled.setRow({ catalogId: null, transport: "stdio", command: "/synthetic/server" });
    await enabled.service.tools(actor, "connection");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/synthetic/server",
        allowedCommands: ["/synthetic/server"],
      }),
    );
  });

  it("captures a manifest on completion and records discovery failures", async () => {
    const f = fixture();
    const inspect = vi
      .spyOn(McpConnector.prototype, "inspectServer")
      .mockResolvedValueOnce(manifest)
      .mockRejectedValueOnce(new Error("fake-secret"));
    await f.service.capture(actor, "connection");
    expect(f.row().manifest).toEqual(manifest);
    expect(f.row().connectionState).toBe("connected");
    await f.service.capture(actor, "connection");
    expect(f.row().connectionState).toBe("connected");
    expect(f.row().lastError).toBe("Could not reach this integration. Try again.");
    expect(JSON.stringify(f.row().recentErrors)).not.toContain("fake-secret");
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  it("requires a new explicit review when an assigned tool definition changes", async () => {
    const f = fixture();
    await f.service.assign(actor, {
      connectionId: "connection",
      botIds: ["bot"],
      toolIds: ["synthetic_read"],
      spaceToolPolicies: { synthetic_read: "allow" },
    });
    vi.spyOn(McpConnector.prototype, "inspectServer").mockResolvedValue({
      ...manifest,
      tools: manifest.tools.map((tool) => ({ ...tool, inputSchemaDigest: "f".repeat(64) })),
    });
    await f.service.capture(actor, "connection");
    expect(await f.service.grants(actor, "connection")).toEqual([
      { botId: "bot", toolIds: [], needsReview: true },
    ]);
    expect(f.row().spaceAllowedTools).toEqual([]);
    expect(f.row().spaceToolPolicies).toEqual({});
    expect(f.row().revision).toBe(3);
  });

  it("does not resurrect a connection revoked during discovery", async () => {
    const f = fixture();
    vi.spyOn(McpConnector.prototype, "inspectServer").mockImplementation(async () => {
      f.setRow({ enabled: false, revision: 2, connectionState: "not-connected" });
      return manifest;
    });
    await f.service.capture(actor, "connection");
    expect(f.row().connectionState).toBe("not-connected");
    expect(f.row().enabled).toBe(false);
  });
  it("stores exact grants and invalidates approvals when grants change", async () => {
    const f = fixture();
    expect(
      await f.service.assign(actor, {
        connectionId: "connection",
        botIds: ["bot"],
        toolIds: ["synthetic_read"],
      }),
    ).toEqual([{ botId: "bot", toolIds: ["synthetic_read"], needsReview: false }]);
    expect(f.row().spaceAllowedTools).toEqual(["synthetic_read"]);
    expect(f.row().revision).toBe(2);
    expect(f.db.botMcpServer.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          allowAllTools: false,
          needsReview: false,
          allowedTools: ["synthetic_read"],
        }),
      ],
    });
    expect(f.db.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "denied" } }),
    );
    await f.service.assign(actor, { connectionId: "connection", botIds: [], toolIds: [] });
    expect(await f.service.grants(actor, "connection")).toEqual([]);
  });
  it("persists owner read policies, returns them, preserves omitted policies and supports Ask first", async () => {
    const f = fixture();
    const input = { connectionId: "connection", botIds: ["bot"], toolIds: ["synthetic_read"] };
    await f.service.assign(actor, { ...input, spaceToolPolicies: { synthetic_read: "allow" } });
    expect(f.row().spaceToolPolicies).toEqual({ synthetic_read: "allow" });
    expect((await f.service.list(actor)).connections[0]?.spaceToolPolicies).toEqual({
      synthetic_read: "allow",
    });
    await f.service.assign(actor, input);
    expect(f.row().spaceToolPolicies).toEqual({ synthetic_read: "allow" });
    await f.service.assign(actor, { ...input, spaceToolPolicies: { synthetic_read: "ask-first" } });
    expect(f.row().spaceToolPolicies).toEqual({ synthetic_read: "ask-first" });
    expect(f.row().revision).toBe(4);
    expect(f.db.externalEffect.updateMany).toHaveBeenCalledTimes(3);
    expect(f.db.spaceMember.findUnique).toHaveBeenCalledWith({ where: { spaceId_userId: actor } });
  });
  it.each(["member", "admin"])(
    "rejects policy updates from a space %s before any mutation",
    async (role) => {
      const f = fixture();
      f.db.spaceMember.findUnique.mockResolvedValue({ role });
      await expect(
        f.service.assign(actor, {
          connectionId: "connection",
          botIds: ["bot"],
          toolIds: ["synthetic_read"],
          spaceToolPolicies: { synthetic_read: "allow" },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.db.botMcpServer.deleteMany).not.toHaveBeenCalled();
      expect(f.db.mcpServer.update).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["synthetic_update", "Synthetic write"],
    ["synthetic_read", "Read and delete an item"],
    ["synthetic_opaque", "An unknown action"],
  ])("rejects owner allow for write-classified %s before any mutation", async (id, description) => {
    const f = fixture();
    f.setRow({ manifest: { ...manifest, tools: [{ ...manifest.tools[0]!, id, description }] } });
    await expect(
      f.service.assign(actor, {
        connectionId: "connection",
        botIds: ["bot"],
        toolIds: [id],
        spaceToolPolicies: { [id]: "allow" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.row().spaceToolPolicies).toEqual({});
    expect(f.db.botMcpServer.deleteMany).not.toHaveBeenCalled();
    expect(f.db.mcpServer.update).not.toHaveBeenCalled();
  });
  it("rejects uncaptured and malformed policies", async () => {
    const f = fixture();
    for (const policies of [
      { absent_read: "allow" },
      { synthetic_read: "invalid" },
      { synthetic_read: { approval: "allow" } },
    ]) {
      await expect(
        f.service.assign(actor, {
          connectionId: "connection",
          botIds: [],
          toolIds: [],
          spaceToolPolicies: policies as never,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(f.db.botMcpServer.deleteMany).not.toHaveBeenCalled();
  });
  it("rejects foreign owners, bots, uncaptured tools, and unconnected accounts", async () => {
    const f = fixture();
    for (const other of [
      { ...actor, userId: "other" },
      { ...actor, spaceId: "other" },
    ]) {
      await expect(f.service.resourceTools(other, "connection", "notion")).rejects.toThrow();
      await expect(
        f.service.searchResources(other, {
          connectionId: "connection",
          kind: "notion",
          toolId: "synthetic_search",
          args: {},
        }),
      ).rejects.toThrow();
      await expect(f.service.grants(other, "connection")).rejects.toThrow();
      await expect(f.service.revoke(other, "connection")).rejects.toThrow();
      await expect(
        f.service.connect(other, {
          catalogId: "github",
          connectionId: "connection",
          token: "synthetic-test-value",
        }),
      ).rejects.toThrow();
      await expect(
        f.service.assign(other, { connectionId: "connection", botIds: ["bot"], toolIds: [] }),
      ).rejects.toThrow();
    }
    await expect(
      f.service.assign(actor, { connectionId: "connection", botIds: ["other"], toolIds: [] }),
    ).rejects.toThrow();
    await expect(
      f.service.assign(actor, {
        connectionId: "connection",
        botIds: ["bot"],
        toolIds: ["invented"],
      }),
    ).rejects.toThrow();
    f.setRow({ connectionState: "awaiting-consent" });
    await expect(
      f.service.assign(actor, { connectionId: "connection", botIds: ["bot"], toolIds: [] }),
    ).rejects.toThrow();
    expect(f.db.botMcpServer.createMany).not.toHaveBeenCalled();
  });
  it.each(["not-connected", "cancelled"] as const)(
    "revokes access, OAuth attempts and pending approvals into %s",
    async (state) => {
      const f = fixture();
      f.setRow({ spaceToolPolicies: { synthetic_read: "allow" } });
      await f.service.revoke(actor, "connection", state);
      expect(f.row()).toMatchObject({
        enabled: false,
        connectionState: state,
        spaceAllowedTools: [],
        spaceToolPolicies: {},
        revision: 2,
      });
      expect(f.db.botMcpServer.deleteMany).toHaveBeenCalled();
      expect(f.db.mcpOAuthSession.deleteMany).toHaveBeenCalled();
      expect(f.db.externalEffect.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          run: { userId: actor.userId },
          status: { in: ["intended", "approved"] },
        }),
        data: { status: "denied" },
      });
      expect(f.oauth.forgetPending).toHaveBeenCalledWith({ serverId: "connection", ...actor });
    },
  );
});

describe("connection recovery and health", () => {
  it("does not replace a successful concurrent token refresh with an older sign-in failure", async () => {
    const f = fixture();
    f.setRow({ secretId: "old-secret", lastError: null });
    vi.spyOn(f.service, "tools").mockImplementation(async () => {
      f.setRow({ secretId: "refreshed-secret", connectionState: "connected" });
      throw new McpReauthorizationRequiredError("connection", "invalid_token");
    });
    await f.service.capture(actor, "connection");
    expect(f.row()).toMatchObject({
      secretId: "refreshed-secret",
      connectionState: "connected",
      lastError: null,
    });
  });
  it("preserves unchanged tools, grants and owner policies across successful health checks", async () => {
    const f = fixture();
    await f.service.assign(actor, {
      connectionId: "connection",
      botIds: ["bot"],
      toolIds: ["synthetic_read"],
      spaceToolPolicies: { synthetic_read: "allow" },
    });
    const revision = f.row().revision;
    vi.spyOn(McpConnector.prototype, "inspectServer").mockResolvedValue(manifest);
    await f.service.capture(actor, "connection");
    expect(f.row().revision).toBe(revision);
    expect(f.row().lastSuccessAt).toBeInstanceOf(Date);
    expect(await f.service.grants(actor, "connection")).toEqual([
      { botId: "bot", toolIds: ["synthetic_read"], needsReview: false },
    ]);
  });
  it("expires consent after ten minutes and removes its credentials and sessions", async () => {
    const f = fixture();
    f.setRow({
      connectionState: "awaiting-consent",
      consentStartedAt: new Date(Date.now() - 600_001),
    });
    await f.service.expireConsent({ ...actor, isDeploymentOwner: true } as never);
    expect(f.row()).toMatchObject({
      connectionState: "not-connected",
      enabled: false,
      lastError: "Sign-in timed out.",
      consentStartedAt: null,
    });
    expect(f.db.mcpOAuthSession.deleteMany).toHaveBeenCalled();
    expect(f.oauth.forgetPending).toHaveBeenCalled();
    expect(f.db.mcpServer.findMany.mock.calls[0]?.[0]).not.toHaveProperty(
      "where.isDeploymentOwner",
    );
  });
  it("does not expire a sign-in that completed after the expiry query", async () => {
    const f = fixture();
    f.setRow({
      connectionState: "awaiting-consent",
      consentStartedAt: new Date(Date.now() - 600_001),
    });
    const query = f.db.mcpServer.findMany.getMockImplementation()!;
    f.db.mcpServer.findMany.mockImplementationOnce(async () => {
      const rows = await query();
      f.setRow({ connectionState: "connected", revision: 2 });
      return rows;
    });
    await f.service.expireConsent(actor);
    expect(f.row().connectionState).toBe("connected");
    expect(f.db.mcpOAuthSession.deleteMany).not.toHaveBeenCalled();
  });
  it("cancels the current connection even after the session revision changed", async () => {
    const f = fixture();
    f.setRow({ revision: 9, connectionState: "awaiting-consent" });
    await f.service.revoke(actor, "connection", "cancelled");
    expect(f.row()).toMatchObject({ enabled: false, connectionState: "cancelled", revision: 10 });
  });
  it("only schedules health checks for granted connections due after thirty minutes", async () => {
    const f = fixture();
    f.db.mcpServer.findMany.mockResolvedValue([]);
    await f.service.checkGranted();
    expect(f.db.mcpServer.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          enabled: true,
          connectionState: "connected",
          assignments: { some: { needsReview: false } },
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: expect.any(Date) } }],
        }),
      }),
    );
    const query = f.db.mcpServer.findMany.mock.calls.at(-1)![0] as {
      where: { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: Date } }] };
    };
    expect(Date.now() - query.where.OR[1].lastCheckedAt.lte.getTime()).toBeGreaterThanOrEqual(
      1_800_000,
    );
  });
  it("creates a host grant without copying a credential into the secret store", async () => {
    const f = fixture();
    vi.spyOn(f.service, "hostSignIns").mockResolvedValue([
      {
        id: "github",
        command: "gh",
        state: "signed-in",
        identity: "test-account",
        workspace: "github.example.test",
        checkedAt: new Date().toISOString(),
      },
    ]);
    const result = await f.service.connect(actor, { catalogId: "github", authKind: "host" });
    expect(result.connection).toMatchObject({
      state: "connected",
      transport: "host-cli",
      manifest: { account: "test-account" },
    });
    expect(f.db.secret.create).not.toHaveBeenCalled();
    expect(f.row().secretId).toBeNull();
    await f.service.assign(actor, {
      connectionId: result.connection.id,
      botIds: ["bot"],
      toolIds: ["execute_command"],
    });
    expect(f.db.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ computer: { kind: "desktop" } }),
      }),
    );
    await expect(
      f.service.assign(actor, {
        connectionId: result.connection.id,
        botIds: ["bot"],
        toolIds: ["execute_command"],
        spaceToolPolicies: { execute_command: "allow" },
      }),
    ).rejects.toThrow("Writes always ask");
  });
});
