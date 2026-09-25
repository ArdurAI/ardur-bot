import type { EncryptedSecretStore } from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { HostBridge } from "./host-bridge.js";
import { mountHostMcpRoutes } from "./host-mcp-routes.js";
import { createMcpSettings } from "./mcp-settings.js";

it("keeps the host online with 200 registrations and explains only the refused excess", async () => {
  const app = new Hono();
  const rows = Array.from({ length: 203 }, (_, i) => ({
    id: `server-${String(i).padStart(3, "0")}`,
    userId: "owner",
    spaceId: i % 2 ? "space-a" : "space-b",
    revision: 1,
    enabled: true,
    placement: "host",
    transport: "stdio",
    diagnostics: {},
    secret: {
      id: `secret-${i}`,
      userId: "owner",
      spaceId: i % 2 ? "space-a" : "space-b",
      ciphertext: "fixture",
    },
  }));
  const updateMany = vi.fn(async ({ where, data }) => {
    const excess = rows.filter(
      (row) => row.userId === where.userId && row.enabled && !where.id.notIn.includes(row.id),
    );
    for (const row of excess) Object.assign(row, data);
    return { count: excess.length };
  });
  const prisma = {
    mcpServer: {
      findMany: vi.fn(async ({ take }) => rows.filter((row) => row.enabled).slice(0, take)),
      findFirst: vi.fn(async ({ where }) =>
        rows.find(
          (row) =>
            row.id === where.id && row.userId === where.userId && row.spaceId === where.spaceId,
        ),
      ),
      updateMany,
    },
  } as unknown as PrismaClient;
  const hostBridge = {
    registrationFor: vi.fn(async () => ({ userId: "owner" })),
    status: vi.fn(async () => ({ connected: true })),
    result: vi.fn(),
  } as unknown as HostBridge;
  const secrets = {
    load: vi.fn(() => JSON.stringify({ command: "node", args: [], env: {}, cwd: "/fixture" })),
  } as unknown as EncryptedSecretStore;
  mountHostMcpRoutes(app, { prisma, hostBridge, secrets });
  const request = () =>
    app.request("/api/host-bridge/mcp", { headers: { authorization: "Bearer fixture" } });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toHaveLength(200);
  expect(rows.filter((row) => row.enabled)).toHaveLength(200);
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        userId: "owner",
        placement: "host",
        transport: "stdio",
        enabled: true,
      }),
    }),
  );
  expect(prisma.mcpServer.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  );
  const settings = createMcpSettings({ prisma, hostBridge, secrets });
  for (const row of rows.slice(200)) {
    expect(row).toMatchObject({ enabled: false, connectionState: "discovery-failed" });
    expect(await settings.logs(row, row.id)).toMatchObject({
      status: "error",
      lastError:
        "This computer supports up to 200 local servers. Disable another server, then enable this one.",
    });
  }
  expect(hostBridge.result).not.toHaveBeenCalled();
  expect((await request()).status).toBe(200);
});

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
