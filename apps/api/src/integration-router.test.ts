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
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
    mcpServer: { findFirst: vi.fn(async () => ({ id: "server", catalogId: "github" })) },
    botMcpServer: { upsert: vi.fn(async () => assignment) },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const oauth = { complete: vi.fn(async () => "server"), begin: vi.fn() };
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
