import type { HostRequest } from "@ardurbot/contracts/host-bridge";
import { HostOperationSchema } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { authorizeHostMcp } from "./host-mcp-authorization.js";

describe("explicit host MCP authorization", () => {
  it("requires ownership, revision, a live run and a fresh tool grant", async () => {
    const server = {
      id: "server",
      userId: "owner",
      spaceId: "space",
      revision: 2,
      placement: "host",
      transport: "stdio",
      enabled: true,
      catalogId: null,
    };
    const grant = { allowedTools: ["read_fixture"], allowAllTools: false, needsReview: false };
    const prisma = {
      mcpServer: {
        findFirst: vi.fn(async ({ where }) =>
          Object.entries(where).every(
            ([key, value]) => server[key as keyof typeof server] === value,
          )
            ? server
            : null,
        ),
      },
      run: { findFirst: vi.fn(async () => ({ id: "run" })) },
      botMcpServer: { findFirst: vi.fn(async () => grant) },
    };
    const request: HostRequest = {
      v: 1,
      type: "request",
      id: "request",
      scope: { userId: "owner", spaceId: "space", runId: "run", botId: "bot" },
      operation: {
        op: "mcp.call",
        serverId: "server",
        revision: 2,
        name: "read_fixture",
        args: {},
      },
    };
    const authorize = (value = request, settings = false) =>
      authorizeHostMcp(prisma as unknown as PrismaClient, value, settings);
    expect(await authorize()).toBe(true);
    expect(await authorize({ ...request, scope: { ...request.scope, userId: "foreign" } })).toBe(
      false,
    );
    expect(await authorize({ ...request, operation: { ...request.operation, revision: 1 } })).toBe(
      false,
    );
    expect(await authorize(request, true)).toBe(false);
    grant.needsReview = true;
    expect(await authorize()).toBe(false);
    grant.needsReview = false;
    prisma.run.findFirst.mockResolvedValue(null as never);
    expect(await authorize()).toBe(false);
    expect(
      await authorize(
        { ...request, operation: { op: "mcp.status", serverId: "server", revision: 2 } },
        true,
      ),
    ).toBe(true);
    expect(
      await authorize({
        ...request,
        operation: { op: "mcp.status", serverId: "server", revision: 2 },
      }),
    ).toBe(false);
  });
  it("rejects arbitrary executable definitions on the operation wire", () => {
    expect(
      HostOperationSchema.safeParse({
        op: "mcp.call",
        serverId: "server",
        revision: 1,
        name: "read",
        args: {},
        command: "untrusted",
      }).success,
    ).toBe(false);
  });
});
