import type { EncryptedSecretStore } from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { HostBridge } from "./host-bridge.js";
import { mountHostMcpRoutes } from "./host-mcp-routes.js";

it("delivers launch material only to a paired host, rejecting browser and anonymous requests", async () => {
  const app = new Hono();
  const rows = [
    {
      id: "server",
      userId: "owner",
      spaceId: "space",
      revision: 2,
      secret: { id: "secret", userId: "owner", spaceId: "space", ciphertext: "ciphertext" },
    },
  ];
  const prisma = { mcpServer: { findMany: vi.fn(async () => rows) } };
  const hostBridge = {
    registrationFor: vi.fn(async (header?: string) =>
      header === "Bearer fixture" ? { userId: "owner" } : null,
    ),
  };
  const secrets = {
    load: vi.fn(() =>
      JSON.stringify({
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "fixture-private-value" },
        cwd: "/fixture",
      }),
    ),
  };
  mountHostMcpRoutes(app, {
    prisma: prisma as unknown as PrismaClient,
    hostBridge: hostBridge as unknown as HostBridge,
    secrets: secrets as unknown as EncryptedSecretStore,
  });
  expect((await app.request("/api/host-bridge/mcp")).status).toBe(401);
  expect(
    (
      await app.request("/api/host-bridge/mcp", {
        headers: { origin: "https://app.example.test", authorization: "Bearer fixture" },
      })
    ).status,
  ).toBe(403);
  expect(secrets.load).not.toHaveBeenCalled();
  const response = await app.request("/api/host-bridge/mcp", {
    headers: { authorization: "Bearer fixture" },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject([
    { serverId: "server", revision: 2, env: { TOKEN: "fixture-private-value" } },
  ]);
  expect(prisma.mcpServer.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { userId: "owner", placement: "host", transport: "stdio", enabled: true },
    }),
  );
});
