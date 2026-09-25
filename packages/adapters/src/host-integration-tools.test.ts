import type { AdapterContext } from "@ardurbot/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeHostIntegration,
  hostIntegrationComputer,
  hostIntegrationTools,
} from "./host-integration-tools.js";
import { integrationApprovalForCall } from "./integration-access.js";
import { captureIntegrationManifest } from "./integration-manifest.js";

const owner = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./runtimes/native-host.js", () => ({ nativeHostOwner: owner }));
afterEach(() => {
  owner.mockResolvedValue(true);
});
const context = {
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
} as AdapterContext;
const computer = { id: "computer", kind: "desktop", providerRef: "fixture-computer" };
const server = {
  id: "connection",
  catalogId: "github",
  manifest: { ...captureIntegrationManifest(hostIntegrationTools, "1"), account: "test-account" },
};

describe("host integration execution", () => {
  it("requires the host owner and a bot assigned to this computer", async () => {
    const prisma = {
      bot: { findFirst: vi.fn(async () => ({ computer: { ...computer, kind: "docker" } })) },
    };
    expect(await hostIntegrationComputer(prisma as never, context)).toBeNull();
    owner.mockResolvedValue(false);
    prisma.bot.findFirst.mockClear();
    expect(await hostIntegrationComputer(prisma as never, context)).toBeNull();
    expect(prisma.bot.findFirst).not.toHaveBeenCalled();
  });
  it("uses the host sandbox with fixed argv and never adds a credential environment", async () => {
    const prisma = { bot: { findFirst: vi.fn(async () => ({ computer })) } };
    const execute = vi.fn(async function* (
      _computer: unknown,
      _request: unknown,
      _context: unknown,
    ) {
      yield { type: "stdout", data: "test issue" };
      yield { type: "stderr", data: "fake-private-source" };
      yield { type: "exit", code: 0 };
    });
    const result = [];
    for await (const event of executeHostIntegration(
      prisma as never,
      { execute } as never,
      server as never,
      "execute_command",
      { args: ["issue", "list"] },
      context,
    ))
      result.push(event);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      argv: ["gh", "issue", "list"],
      timeoutMs: 60_000,
      hostIntegration: { id: "github", identity: "test-account", workspace: null },
    });
    expect(result).toEqual([{ type: "result", data: { output: "test issue" } }]);
  });
  it("cannot turn a mutating CLI tool into an allow rule", async () => {
    const assignment = {
      allowAllTools: false,
      needsReview: false,
      allowedTools: ["execute_command"],
      server: {
        ...server,
        enabled: true,
        connectionState: "connected",
        spaceAllowedTools: ["execute_command"],
        spaceToolPolicies: { execute_command: "allow" },
        manifest: captureIntegrationManifest(hostIntegrationTools, "1"),
      },
    };
    const prisma = { botMcpServer: { findFirst: vi.fn(async () => assignment) } };
    const result = await integrationApprovalForCall(
      prisma as never,
      { connectorId: "mcp", resourceId: "connection", toolName: "execute_command" } as never,
      context,
      { args: ["issue", "create", "--title", "test"] },
    );
    expect(result).toBe("ask-first");
  });
});
