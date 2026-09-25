import type { Actor } from "@ardurbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConnections } from "./integration-connections.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

afterEach(() => vi.restoreAllMocks());
const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

function fixture() {
  const assignment = {
    id: "grant",
    botId: "bot",
    serverId: "server",
    allowAllTools: false,
    needsReview: true,
    allowedTools: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
    mcpServer: {
      findFirst: vi.fn(async () => ({ id: "server", catalogId: "github" })),
      update: vi.fn(),
    },
    botMcpServer: { upsert: vi.fn(async () => assignment), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const oauth = {
    complete: vi.fn(async () => "server"),
    begin: vi.fn(),
    statusFor: vi.fn(async () => "none"),
  };
  const handler = new RPCHandler(
    createRouter({
      prisma,
      mcpOAuth: oauth,
      env: { webOrigin: "https://app.example.test" },
    } as unknown as RouterDeps),
  );
  const request = async (path: string, input: unknown, caller: Actor | null = actor) => {
    const { response } = await handler.handle(
      new Request(`https://app.example.test/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return response;
  };
  return { prisma, oauth, request };
}

describe("integration RPC boundaries", () => {
  it("routes MCP permissions through the shared service with the MCP ownership boundary", async () => {
    const f = fixture();
    const assign = vi.spyOn(IntegrationConnections.prototype, "assign").mockResolvedValue([]);
    const input = {
      serverId: "server",
      botIds: ["bot"],
      toolIds: ["get_item"],
      spaceToolPolicies: { get_item: "ask-first" },
    };
    expect((await f.request("mcp/servers/permissions", input))?.status).toBe(200);
    expect(assign).toHaveBeenCalledExactlyOnceWith(
      actor,
      { ...input, connectionId: "server" },
      "mcp",
    );
    expect((await f.request("mcp/servers/permissions", input, null))?.status).toBe(401);
    expect(assign).toHaveBeenCalledTimes(1);
  });
  it("refuses write Allow for a custom MCP server at the API boundary", async () => {
    const f = fixture();
    f.prisma.mcpServer.findFirst.mockResolvedValueOnce({
      id: "server",
      catalogId: null,
      enabled: true,
      connectionState: "connected",
      manifest: {
        capturedAt: "2026-09-24T00:00:00.000Z",
        serverVersion: null,
        account: null,
        tools: [
          { id: "update_item", description: "Update an item", inputSchemaDigest: "a".repeat(64) },
        ],
      },
    } as never);
    const response = await f.request("mcp/servers/permissions", {
      serverId: "server",
      botIds: [],
      toolIds: ["update_item"],
      spaceToolPolicies: { update_item: "allow" },
    });
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain("Writes always ask");
    expect(f.prisma.mcpServer.update).not.toHaveBeenCalled();
  });
  it("enables a custom default without replacing credentials and requires fresh tool approval", async () => {
    const f = fixture();
    const row = {
      id: "server",
      spaceId: actor.spaceId,
      userId: actor.userId,
      catalogId: null,
      managedBy: null,
      slug: "default",
      name: "Default",
      description: "",
      transport: "streamable_http",
      endpoint: "https://example.test/mcp",
      command: null,
      args: [],
      env: {},
      headers: { Authorization: true },
      secretId: "encrypted",
      enabled: false,
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    f.prisma.mcpServer.findFirst.mockResolvedValueOnce(row as never);
    f.prisma.mcpServer.update.mockResolvedValue({ ...row, enabled: true, revision: 2 });
    const response = await f.request("mcp/servers/update", { id: "server", enabled: true });
    expect(response?.status).toBe(200);
    expect(f.prisma.mcpServer.update).toHaveBeenCalledWith({
      where: { id: "server" },
      data: { enabled: true, connectionState: "not-connected", revision: { increment: 1 } },
    });
    expect(f.prisma.botMcpServer.updateMany).toHaveBeenCalledWith({
      where: { serverId: "server", spaceId: "space", userId: "owner" },
      data: { needsReview: true, allowAllTools: false, allowedTools: [] },
    });
    expect(f.prisma.mcpServer.findFirst).toHaveBeenCalledWith({
      where: { id: "server", spaceId: "space", userId: "owner" },
    });
  });
  it.each([
    { managedBy: "extension", catalogId: null },
    { managedBy: "plugin", catalogId: null },
    { catalogId: "github" },
  ])("keeps managed enablement in its owning page: %j", async (fields) => {
    const f = fixture();
    f.prisma.mcpServer.findFirst.mockResolvedValue({ id: "server", ...fields } as never);
    expect((await f.request("mcp/servers/update", { id: "server", enabled: true }))?.status).toBe(
      400,
    );
    expect(f.prisma.mcpServer.update).not.toHaveBeenCalled();
    expect(f.prisma.botMcpServer.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    ["synthetic_write", "Write an item"],
    ["synthetic_read", "Read and delete an item"],
  ])("rejects owner allow for write-classified %s through the API", async (id, description) => {
    const f = fixture();
    f.prisma.mcpServer.findFirst.mockResolvedValueOnce({
      id: "server",
      catalogId: "github",
      enabled: true,
      connectionState: "connected",
      manifest: {
        capturedAt: "2026-09-23T00:00:00.000Z",
        serverVersion: null,
        account: null,
        tools: [{ id, description, inputSchemaDigest: "a".repeat(64) }],
      },
    } as never);
    const response = await f.request("integrations/assign", {
      connectionId: "server",
      botIds: [],
      toolIds: [id],
      spaceToolPolicies: { [id]: "allow" },
    });
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain("Writes always ask");
    expect(f.prisma.botMcpServer.upsert).not.toHaveBeenCalled();
  });
  it("rejects malformed policies at the RPC boundary", async () => {
    const f = fixture();
    expect(
      (
        await f.request("integrations/assign", {
          connectionId: "server",
          botIds: [],
          toolIds: [],
          spaceToolPolicies: { synthetic_read: "always" },
        })
      )?.status,
    ).toBe(400);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("keeps onboarding and approval-card assignments empty until tool review", async () => {
    const f = fixture();
    const response = await f.request("mcp/assignments/approve", {
      botId: "bot",
      serverId: "server",
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      json: { allowAllTools: false, needsReview: true, allowedTools: [] },
    });
    expect(f.prisma.botMcpServer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          allowAllTools: false,
          needsReview: true,
          allowedTools: [],
        }),
      }),
    );
  });
  it("rejects a blanket-grant request before database access", async () => {
    const f = fixture();
    const response = await f.request("mcp/assignments/replace", {
      botId: "bot",
      assignments: [{ serverId: "server", allowAllTools: true }],
    });
    expect(response?.status).toBe(400);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated catalog mutations and untrusted callback redirects", async () => {
    const f = fixture();
    expect((await f.request("integrations/connect", { catalogId: "github" }, null))?.status).toBe(
      401,
    );
    expect(
      (
        await f.request("mcp/oauth/begin", {
          serverId: "server",
          redirectUri: "https://other.example.test/callback",
        })
      )?.status,
    ).toBe(400);
    expect(f.oauth.begin).not.toHaveBeenCalled();
  });
  it("captures only after the existing OAuth broker validates completion", async () => {
    const f = fixture();
    const capture = vi.spyOn(IntegrationConnections.prototype, "capture").mockResolvedValue();
    const input = { sessionId: "session", code: "synthetic-code", state: "session" };
    expect((await f.request("mcp/oauth/complete", input))?.status).toBe(200);
    expect(f.oauth.complete).toHaveBeenCalledWith({
      ...input,
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    expect(capture).toHaveBeenCalledWith(actor, "server");
    capture.mockClear();
    f.oauth.complete.mockRejectedValueOnce(new Error("fake-sensitive-oauth-response"));
    const response = await f.request("mcp/oauth/complete", input);
    expect(response?.status).toBe(400);
    expect(await response?.text()).not.toContain("fake-sensitive");
    expect(capture).not.toHaveBeenCalled();
  });
  it("does not let generic MCP configuration replace a trusted endpoint or credentials", async () => {
    const f = fixture();
    expect(
      (await f.request("mcp/servers/update", { id: "server", secret: "synthetic-token" }))?.status,
    ).toBe(400);
  });
});
