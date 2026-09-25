import type { AdapterContext } from "@ardurbot/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import {
  executeHostIntegration,
  hostIntegrationComputer,
  hostIntegrationTools,
  prepareHostCommandApproval,
} from "./host-integration-tools.js";
import {
  integrationApprovalDetailsForCall,
  integrationApprovalForCall,
} from "./integration-access.js";
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
const resolveCommandCwd = vi.fn(async () => "/workspace");

describe("host integration execution", () => {
  it("shows the complete AWS command in its approval instead of a generic write question", async () => {
    const args = { args: ["s3", "rm", "s3://example-bucket", "--recursive"] };
    const prisma = {
      bot: { findFirst: vi.fn(async () => ({ computer })) },
      botMcpServer: {
        findFirst: vi.fn(async () => ({
          allowAllTools: false,
          allowedTools: ["execute_command"],
          server: {
            ...server,
            catalogId: "aws",
            transport: "host-cli",
            enabled: true,
            revision: 1,
            connectionState: "connected",
            spaceAllowedTools: ["execute_command"],
          },
        })),
      },
    };
    const details = await integrationApprovalDetailsForCall(
      prisma as never,
      {
        connectorId: "mcp",
        resourceId: "connection",
        resourceRevision: 1,
        toolName: "execute_command",
      },
      context,
      args,
      undefined,
      { resolveCommandCwd: vi.fn(async () => "/workspace") } as never,
    );
    const block = buildApprovalAskBlock("effect", "mcp__aws__execute_command", args, [], {
      integration: details?.integration,
    });
    expect(block).toMatchObject({ text: "'aws' 's3' 'rm' 's3://example-bucket' '--recursive'" });
    if (block.kind !== "ask") throw new Error("Expected an approval");
    expect(block.detail).toContain("test-account");
    expect(block.detail).toContain("/workspace");
  });
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
    const sandbox = { execute, resolveCommandCwd };
    const { approval } = await prepareHostCommandApproval(
      prisma as never,
      sandbox as never,
      server as never,
      { args: ["issue", "list"] },
      context,
    );
    for await (const event of executeHostIntegration(
      prisma as never,
      sandbox as never,
      server as never,
      "execute_command",
      { args: ["issue", "list"] },
      { ...context, hostCommandApproval: approval },
    ))
      result.push(event);
    expect(execute.mock.calls[0]?.[1]).toEqual({
      argv: ["gh", "issue", "list"],
      cwd: "/workspace",
      timeoutMs: 60_000,
      hostIntegration: { id: "github", identity: "test-account", workspace: null },
    });
    expect(result).toEqual([{ type: "result", data: { output: "test issue" } }]);
  });
  it.each(["missing", "program", "args", "identity", "workspace", "cwd", "computer"])(
    "refuses execution when the %s differs from the approved snapshot",
    async (changed) => {
      const currentComputer = { ...computer };
      const currentServer = structuredClone(server);
      const prisma = { bot: { findFirst: vi.fn(async () => ({ computer: currentComputer })) } };
      const sandbox = { resolveCommandCwd: vi.fn(async () => "/workspace"), execute: vi.fn() };
      const args = { args: ["issue", "create", "--title", "Approved title"] };
      const { approval } = await prepareHostCommandApproval(
        prisma as never,
        sandbox as never,
        currentServer as never,
        args,
        context,
      );
      if (changed === "program") approval.argv[0] = "glab";
      if (changed === "args") args.args[3] = "Changed title";
      if (changed === "identity") currentServer.manifest.account = "other-test-account";
      if (changed === "workspace")
        Object.assign(currentServer.manifest, { workspace: "other-workspace" });
      if (changed === "cwd") sandbox.resolveCommandCwd.mockResolvedValue("/other-workspace");
      if (changed === "computer") currentComputer.id = "other-computer";
      await expect(
        (async () => {
          for await (const _event of executeHostIntegration(
            prisma as never,
            sandbox as never,
            currentServer as never,
            "execute_command",
            args,
            { ...context, hostCommandApproval: changed === "missing" ? undefined : approval },
          )) {
            /* No command may run. */
          }
        })(),
      ).rejects.toThrow("Review it again");
      expect(sandbox.execute).not.toHaveBeenCalled();
    },
  );
  it("refuses to prepare an approval when the working directory is unavailable", async () => {
    await expect(
      prepareHostCommandApproval(
        { bot: { findFirst: async () => ({ computer }) } } as never,
        { resolveCommandCwd: async () => null } as never,
        server as never,
        { args: ["issue", "list"] },
        context,
      ),
    ).rejects.toThrow("working directory is unavailable");
  });
  it("displays a redaction marker while executing only the original approved argv", async () => {
    const args = { args: ["issue", "create", "--title", "ghp_fixturevalue123"] };
    const prisma = { bot: { findFirst: vi.fn(async () => ({ computer })) } };
    const sandbox = {
      resolveCommandCwd,
      execute: vi.fn(async function* (_computer: unknown, _request: unknown) {
        yield { type: "exit", code: 0 };
      }),
    };
    const { approval } = await prepareHostCommandApproval(
      prisma as never,
      sandbox as never,
      server as never,
      args,
      context,
    );
    const block = buildApprovalAskBlock("effect", "execute_command", args, [], {
      integration: {
        vendorName: "GitHub",
        toolId: "execute_command",
        description: "Execute a command.",
        hostCommand: approval,
      },
    });
    expect(block.text).toBe("'gh' 'issue' 'create' '--title' '[redacted]'");
    for await (const _event of executeHostIntegration(
      prisma as never,
      sandbox as never,
      server as never,
      "execute_command",
      args,
      { ...context, hostCommandApproval: approval },
    )) {
      /* Drain the approved command. */
    }
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ argv: ["gh", ...args.args] }),
      expect.anything(),
    );
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
