import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("@ardurbot/db", () => ({
  Prisma: { sql: vi.fn() },
  DeviceRequestError: class extends Error {},
  createRepos: vi.fn(() => ({})),
  createGroupRepos: vi.fn(() => ({})),
}));

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
const rows = [
  { kind: "desktop", connectionId: null, host: true },
  { kind: "desktop", connectionId: "docker", host: false },
  { kind: "desktop", connectionId: "podman", host: false },
  { kind: "remote-docker", connectionId: "docker", host: false },
  { kind: "desktop", connectionId: "missing", host: false },
  { kind: "desktop", connectionId: "", host: false },
];

it.each(rows)(
  "lists connected integrations on compatible computers for $kind / $connectionId",
  async (row) => {
    const findFirst = vi.fn(async ({ select }) => ({
      id: "bot",
      computer: Object.fromEntries(
        Object.entries(row).filter(([key]) => select.computer.select[key]),
      ),
    }));
    const servers = ["host-cli", "http"].map((transport) => ({
      id: transport,
      name: transport,
      transport,
      enabled: true,
      connectionState: "connected",
      spaceAllowedTools: ["read"],
      assignments: [],
    }));
    const prisma = {
      bot: { findFirst },
      mcpServer: { findMany: vi.fn(async () => servers) },
    } as unknown as PrismaClient;
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
    );
    const { response } = await handler.handle(
      new Request("http://fixture.test/rpc/integrations/available", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      json: [
        ...(row.host ? [{ id: "host-cli", name: "host-cli", toolsNeedReview: false }] : []),
        { id: "http", name: "http", toolsNeedReview: false },
      ],
    });
    expect(prisma.mcpServer.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { spaceId: "space", userId: "owner", enabled: true },
      include: {
        assignments: { where: { botId: "bot", spaceId: "space", userId: "owner" } },
      },
    });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "bot", spaceId: "space", userId: "owner", archivedAt: null },
      select: { id: true, computer: { select: { kind: true, connectionId: true } } },
    });
  },
);
