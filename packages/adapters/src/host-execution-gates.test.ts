import type { AdapterContext } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { BoardService } from "./board/service.js";
import { hostIntegrationComputer } from "./host-integration-tools.js";
import { mcpGrantForBot } from "./integration-access.js";
import { captureIntegrationManifest } from "./integration-manifest.js";
import { McpConnector } from "./mcp-connector.js";
import { EncryptedSecretStore } from "./secrets.js";

vi.mock("@ardurbot/db", () => ({
  Prisma: { sql: vi.fn() },
  DeviceRequestError: class extends Error {},
}));
vi.mock("./executor.js", () => ({ appendToolCompletionAudit: vi.fn() }));
vi.mock("./runtimes/native-host.js", () => ({ nativeHostOwner: async () => true }));

const rows = [
  { name: "host", kind: "desktop", connectionId: null, host: true },
  { name: "legacy Docker", kind: "desktop", connectionId: "docker", host: false },
  { name: "legacy Podman", kind: "desktop", connectionId: "podman", host: false },
  { name: "remote Docker", kind: "remote-docker", connectionId: "docker", host: false },
  { name: "unresolved", kind: "desktop", connectionId: "missing", host: false },
  { name: "empty", kind: "desktop", connectionId: "", host: false },
];
const context = {
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  runId: "run",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
} as AdapterContext;
const tools = [
  { name: "get_identity", description: "Read account", inputSchema: { type: "object" } },
];
const server = {
  id: "cli",
  slug: "github",
  transport: "host-cli",
  catalogId: "github",
  enabled: true,
  connectionState: "connected",
  revision: 1,
  needsReview: false,
  spaceAllowedTools: ["get_identity"],
  manifest: captureIntegrationManifest(tools, "1"),
};
function fixture(row: (typeof rows)[number]) {
  const computer = { ...row, id: "computer", spaceId: "space", providerRef: "/fixture/workspace" };
  const assignment = {
    serverId: server.id,
    server,
    access: "inherit",
    allowAllTools: false,
    needsReview: false,
    allowedTools: [],
  };
  const bot = { id: "bot", name: "Builder", computer };
  const prisma = {
    bot: { findFirst: vi.fn(async () => bot) },
    botMcpServer: { findFirst: vi.fn(async () => assignment) },
    mcpServer: {
      findFirst: vi.fn(async () => server),
      findMany: vi.fn(async () => [{ ...server, assignments: [assignment] }]),
    },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
  };
  return { prisma, computer };
}

describe.each(rows)("$name host authority", (row) => {
  it("gates Board actor", async () => {
    const { prisma } = fixture(row);
    const service = new BoardService({ prisma: prisma as never, dataDir: "/fixture" });
    if (row.host) await expect(service.actor(context)).resolves.toBe("bot:Builder");
    else
      await expect(service.actor(context)).rejects.toMatchObject({
        problem: { code: "forbidden" },
      });
  });
  it.each(["explicit", "inherited"])("gates %s CLI grant", async (mode) => {
    const { prisma } = fixture(row);
    if (mode === "inherited") prisma.botMcpServer.findFirst.mockResolvedValue(null as never);
    expect(Boolean(await mcpGrantForBot(prisma as never, context, "cli"))).toBe(row.host);
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, computer: { select: { kind: true, connectionId: true } } },
      }),
    );
  });
  it("gates CLI computer resolution", async () => {
    const { prisma, computer } = fixture(row);
    expect(await hostIntegrationComputer(prisma as never, context)).toEqual(
      row.host ? computer : null,
    );
  });
  it("gates CLI discovery before execution authorization", async () => {
    const { prisma } = fixture(row);
    // Isolate the discovery gate from the independently tested execution gate.
    prisma.bot.findFirst.mockResolvedValueOnce({
      id: "bot",
      name: "Builder",
      computer: { ...row, providerRef: "/fixture/workspace" },
    } as never);
    prisma.bot.findFirst.mockResolvedValue({
      id: "bot",
      name: "Builder",
      computer: { kind: "desktop", connectionId: null, providerRef: "/fixture/workspace" },
    } as never);
    const connector = new McpConnector(
      prisma as never,
      new EncryptedSecretStore("fixture-encryption-material"),
    );
    try {
      const discovered = await connector.discoverTools(context);
      expect(discovered).toHaveLength(row.host ? 1 : 0);
    } finally {
      await connector.close();
    }
  });
});
