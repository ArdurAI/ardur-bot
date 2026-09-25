import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";
import { EncryptedSecretStore } from "./secrets.js";

it("routes packaged discovery and calls with the current run's identity without reading launch credentials", async () => {
  const server = {
    id: "server",
    spaceId: "space",
    userId: "owner",
    slug: "fixture",
    revision: 1,
    transport: "stdio",
    placement: "host",
    enabled: true,
    catalogId: null,
  };
  const assignment = {
    serverId: server.id,
    server,
    allowedTools: ["read_fixture"],
    allowAllTools: false,
    needsReview: false,
  };
  const prisma = {
    botMcpServer: {
      findMany: vi.fn(async () => [assignment]),
      findFirst: vi.fn(async () => assignment),
    },
    secret: { findFirst: vi.fn() },
  };
  const host = {
    result: vi.fn(async (operation: { op: string }, _context: Partial<AdapterContext>) =>
      operation.op === "mcp.tools"
        ? {
            tools: [
              {
                name: "read_fixture",
                description: "Read fixture",
                inputSchema: { type: "object" },
              },
            ],
            serverVersion: "1.0.0",
          }
        : { content: [{ type: "text", text: "Fixture result" }] },
    ),
  };
  const connector = new McpConnector(
    prisma as unknown as PrismaClient,
    new EncryptedSecretStore("fixture"),
    { hostMcp: host },
  );
  const context = (runId: string, botId: string): AdapterContext => ({
    spaceId: "space",
    userId: "owner",
    botId,
    runId,
    traceId: runId,
    operationId: runId,
    signal: new AbortController().signal,
  });
  try {
    await connector.discoverTools(context("run-one", "bot-one"));
    const [tool] = await connector.discoverTools(context("run-two", "bot-two"));
    const events = [];
    for await (const event of connector.execute(
      { tool: tool!.name, route: tool!.route, args: {}, executionId: "call" },
      context("run-three", "bot-three"),
    ))
      events.push(event);
    expect(events[0]?.type).toBe("result");
    expect(host.result.mock.calls.map((call) => (call[1] as AdapterContext).runId)).toEqual([
      "run-one",
      "run-two",
      "run-three",
    ]);
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
    expect(host.result.mock.calls[2]?.[0]).toMatchObject({
      op: "mcp.call",
      serverId: "server",
      revision: 1,
      name: "read_fixture",
    });
  } finally {
    await connector.close();
  }
});
