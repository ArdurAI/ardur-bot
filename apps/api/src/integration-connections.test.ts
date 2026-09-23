import { captureIntegrationManifest, McpConnector } from "@ardurbot/adapters";
import type { McpServer } from "@ardurbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSession } from "../../../packages/adapters/src/mcp-transport.js";
import { IntegrationConnections, needsClientRegistration } from "./integration-connections.js";

afterEach(() => vi.restoreAllMocks());
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
      row = { ...row, ...data, manifest: null, connectionState: "awaiting-consent" };
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
  const db = {
    mcpServer,
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
  };
  const service = new IntegrationConnections(
    db as never,
    oauth as never,
    {} as never,
    "https://app.example.test",
    { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    stdio,
  );
  return {
    service,
    db,
    oauth,
    row: () => row,
    setRow: (patch: Partial<McpServer>) => {
      Object.assign(row, patch);
    },
  };
}

describe("catalog connection lifecycle", () => {
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
      redirectUri: "https://app.example.test/mcp/oauth/callback",
    });
    expect(result.connection.state).toBe("awaiting-consent");
    expect(result.authorizationUrl).toBe("https://example.test/authorize");
  });
  it.each(["jenkins", "kubernetes", "aws", "google-cloud", "azure", "unknown"])(
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
    expect((await f.service.connect(actor, { catalogId: "github" })).connection.state).toBe(
      "needs-client-registration",
    );
    f.oauth.begin.mockRejectedValueOnce(new Error("Bearer fake-secret"));
    const failed = await f.service.connect(actor, { catalogId: "github" });
    expect(failed.connection.state).toBe("discovery-failed");
    expect(JSON.stringify(failed)).not.toContain("fake-secret");
    expect(needsClientRegistration(new Error("network failed"))).toBe(false);
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
    expect(f.row().connectionState).toBe("discovery-failed");
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  it("requires a new explicit review after recapturing an assigned manifest", async () => {
    const f = fixture();
    await f.service.assign(actor, {
      connectionId: "connection",
      botIds: ["bot"],
      toolIds: ["synthetic_read"],
    });
    vi.spyOn(McpConnector.prototype, "inspectServer").mockResolvedValue(manifest);
    await f.service.capture(actor, "connection");
    expect(await f.service.grants(actor, "connection")).toEqual([
      { botId: "bot", toolIds: [], needsReview: true },
    ]);
    expect(f.row().spaceAllowedTools).toEqual([]);
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
  it("rejects foreign owners, bots, uncaptured tools, and unconnected accounts", async () => {
    const f = fixture();
    for (const other of [
      { ...actor, userId: "other" },
      { ...actor, spaceId: "other" },
    ]) {
      await expect(f.service.grants(other, "connection")).rejects.toThrow();
      await expect(f.service.revoke(other, "connection")).rejects.toThrow();
      await expect(
        f.service.connect(other, { catalogId: "github", connectionId: "connection" }),
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
      await f.service.revoke(actor, "connection", state);
      expect(f.row()).toMatchObject({
        enabled: false,
        connectionState: state,
        spaceAllowedTools: [],
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
      expect(f.oauth.disconnect).toHaveBeenCalledWith({ serverId: "connection", ...actor });
    },
  );
});
