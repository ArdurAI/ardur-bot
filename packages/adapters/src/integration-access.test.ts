import type { AdapterContext, ConnectorCall } from "@ardurbot/adapter-kit";
import type { SpaceToolPolicies } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  grantedMcpTools,
  integrationApprovalForCall,
  integrationResourceDenial,
} from "./integration-access.js";
import { captureIntegrationManifest } from "./integration-manifest.js";
import { McpConnector } from "./mcp-connector.js";

// All tool names in this test are synthetic; no vendor tool list is asserted.
const tools = Array.from({ length: 25 }, (_, index) => ({
  name: `synthetic_read_${index}`,
  description: "Synthetic read for authorization tests",
  inputSchema: { type: "object" as const },
}));
const manifest = captureIntegrationManifest(tools, "synthetic");
const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};

function fixture() {
  const assignment = {
    id: "grant",
    allowAllTools: false,
    needsReview: false,
    allowedTools: tools.map((tool) => tool.name),
    serverId: "server",
    server: {
      id: "server",
      slug: "test",
      enabled: true,
      catalogId: "github" as string | null,
      connectionState: "connected",
      revision: 1,
      manifest,
      endpoint: "https://api.githubcopilot.com/mcp/",
      transport: "streamable_http",
      secretId: null,
      spaceAllowedTools: tools.map((tool) => tool.name),
      spaceToolPolicies: {} as SpaceToolPolicies,
      resourceConstraints: {} as unknown,
    },
  };
  const calls: string[] = [];
  let initializations = 0;
  const db = {
    botMcpServer: {
      findMany: vi.fn(async () => [assignment]),
      findFirst: vi.fn(async () => assignment),
    },
  };
  const network = {
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    fetch: vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: { name: string };
      };
      if (body.method === "initialize") {
        initializations++;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic", version: "1" },
          },
        });
      }
      if (body.method === "tools/list")
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools } });
      if (body.method === "tools/call") {
        calls.push(body.params!.name);
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "ok" }] },
        });
      }
      return new Response(null, { status: 202 });
    }),
  };
  return {
    assignment,
    db,
    network,
    calls,
    initializations: () => initializations,
    connector: new McpConnector(db as never, {} as never, { network }),
  };
}

async function collect(connector: McpConnector, call: ConnectorCall) {
  const results = [];
  for await (const event of connector.execute(call, context)) results.push(event);
  return results;
}
const direct = (name: string): ConnectorCall => ({
  tool: `mcp__test__${name}`,
  args: {},
  executionId: "test",
  route: { connectorId: "mcp", resourceId: "server", resourceRevision: 1, toolName: name },
});
const lazy = (name: string): ConnectorCall => ({
  tool: "connectors_execute_tool",
  args: { id: `server:${name}`, arguments: {} },
  executionId: "test",
  route: { connectorId: "mcp", toolName: "__catalog_execute" },
});

describe("MCP integration authorization", () => {
  it("enforces Allow, Ask and Block for custom MCP tools and fences stale grants", async () => {
    const f = fixture();
    f.assignment.server.catalogId = null;
    const id = tools[0]!.name;
    const check = (args = {}) =>
      integrationApprovalForCall(f.db as never, direct(id).route, context, args);
    expect(await check()).toBe("ask-first");
    f.assignment.server.spaceToolPolicies = { [id]: "allow" };
    expect(await check()).toBe("allow");
    expect(await check({ action: "delete" })).toBe("ask-first");
    f.assignment.server.spaceToolPolicies = { [id]: "ask-first" };
    expect(await check()).toBe("ask-first");
    f.assignment.allowedTools = [];
    expect(await check()).toBe("disabled");
    f.assignment.allowedTools = [id];
    f.assignment.server.revision++;
    expect(await check()).toBe("disabled");
    expect(await collect(f.connector, direct(id))).toMatchObject([{ type: "error" }]);
    expect(f.network.fetch).not.toHaveBeenCalled();
    await f.connector.close();
  });
  it("uses fresh owner policies only for granted reads, without changing the intersection", async () => {
    const f = fixture();
    const id = tools[0]!.name;
    const check = () => integrationApprovalForCall(f.db as never, direct(id).route, context, {});
    expect(await check()).toBe("ask-first");
    f.assignment.server.spaceToolPolicies = { [id]: "allow" };
    expect(await check()).toBe("allow");
    f.assignment.server.spaceToolPolicies = { [id]: "ask-first" };
    expect(await check()).toBe("ask-first");
    f.assignment.server.spaceToolPolicies = { [id]: "allow" };
    f.assignment.server.spaceAllowedTools = [];
    expect(await check()).toBe("disabled");
    f.assignment.server.spaceAllowedTools = [id];
    f.assignment.allowedTools = [];
    expect(await check()).toBe("disabled");
    f.assignment.allowedTools = [id];
    f.assignment.server.manifest = { ...manifest, tools: [] };
    expect(await check()).toBe("disabled");
    await f.connector.close();
  });
  it("falls back to asking for malformed stored policies", async () => {
    const f = fixture();
    const id = tools[0]!.name;
    f.assignment.server.spaceToolPolicies = { [id]: { approval: "allow" } } as never;
    expect(await integrationApprovalForCall(f.db as never, direct(id).route, context, {})).toBe(
      "ask-first",
    );
    await f.connector.close();
  });
  it("uses the vendor, space, and bot intersection in discovery and direct execution", async () => {
    const f = fixture();
    f.assignment.allowedTools = [tools[0]!.name, tools[1]!.name, "absent"];
    f.assignment.server.spaceAllowedTools = [tools[0]!.name];
    expect((await f.connector.discoverTools(context)).map((tool) => tool.name)).toEqual([
      `mcp__test__${tools[0]!.name}`,
    ]);
    expect(await collect(f.connector, direct(tools[1]!.name))).toMatchObject([{ type: "error" }]);
    expect(f.calls).toEqual([]);
    expect(await collect(f.connector, direct(tools[0]!.name))).toMatchObject([{ type: "result" }]);
    expect(f.calls).toEqual([tools[0]!.name]);
    await f.connector.close();
  });
  it("rechecks grants for lazy resolution, cached calls, and the executor gate", async () => {
    const f = fixture();
    expect((await f.connector.discoverTools(context)).map((tool) => tool.name)).toContain(
      "connectors_execute_tool",
    );
    const resolved = await f.connector.resolveCall(lazy(tools[0]!.name), context);
    expect(resolved?.call.route?.toolName).toBe(tools[0]!.name);
    expect(await integrationApprovalForCall(f.db as never, resolved?.call.route, context, {})).toBe(
      "ask-first",
    );
    f.assignment.allowedTools = [];
    await expect(f.connector.resolveCall(lazy(tools[0]!.name), context)).rejects.toThrow(
      "not authorized",
    );
    expect(await collect(f.connector, lazy(tools[0]!.name))).toMatchObject([{ type: "error" }]);
    expect(await collect(f.connector, resolved!.call)).toMatchObject([{ type: "error" }]);
    expect(await integrationApprovalForCall(f.db as never, resolved?.call.route, context, {})).toBe(
      "disabled",
    );
    expect(f.calls).toEqual([]);
    await f.connector.close();
  });
  it.each(["needsReview", "allowAllTools"] as const)(
    "grants nothing for %s, including discovery",
    async (flag) => {
      const f = fixture();
      f.assignment[flag] = true;
      expect(
        grantedMcpTools(
          f.assignment,
          tools.map((tool) => tool.name),
        ),
      ).toEqual([]);
      expect(await f.connector.discoverTools(context)).toEqual([]);
      expect(await collect(f.connector, direct(tools[0]!.name))).toMatchObject([{ type: "error" }]);
      expect(f.network.fetch).not.toHaveBeenCalled();
      await f.connector.close();
    },
  );
  it("closes cached sessions on revocation and rebuilds only after an explicit new grant", async () => {
    const f = fixture();
    await f.connector.discoverTools(context);
    expect(f.initializations()).toBe(1);
    await McpConnector.invalidateConnection("server", context);
    f.assignment.allowedTools = [];
    expect(await collect(f.connector, direct(tools[0]!.name))).toMatchObject([{ type: "error" }]);
    expect(f.calls).toEqual([]);
    f.assignment.allowedTools = [tools[0]!.name];
    await f.connector.discoverTools(context);
    expect(f.initializations()).toBe(2);
    await f.connector.close();
  });

  it("denies changed schemas, revisions, disabled connections, and foreign bot contexts", async () => {
    const f = fixture();
    f.assignment.server.manifest = {
      ...manifest,
      tools: manifest.tools.map((tool) => ({ ...tool, inputSchemaDigest: "0".repeat(64) })),
    };
    expect(await f.connector.discoverTools(context)).toEqual([]);
    expect(await collect(f.connector, direct(tools[0]!.name))).toMatchObject([{ type: "error" }]);
    f.assignment.server.revision++;
    expect(
      await integrationApprovalForCall(f.db as never, direct(tools[0]!.name).route, context, {}),
    ).toBe("disabled");
    f.assignment.server.enabled = false;
    expect(await collect(f.connector, direct(tools[0]!.name))).toMatchObject([{ type: "error" }]);
    f.db.botMcpServer.findFirst.mockResolvedValueOnce(null as never);
    expect(
      await integrationApprovalForCall(
        f.db as never,
        direct(tools[0]!.name).route,
        { ...context, userId: "other" },
        {},
      ),
    ).toBe("disabled");
    expect(f.db.botMcpServer.findFirst).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ spaceId: "space", userId: "other", botId: "bot" }),
      include: { server: true },
    });
    expect(f.calls).toEqual([]);
    await f.connector.close();
  });
});

describe("resource boundaries", () => {
  const write = { id: "synthetic_write", description: "Write an item." };
  const notion = {
    catalogId: "notion",
    resourceConstraints: { notion: { parentId: "a".repeat(32), kind: "page" } },
  };
  const atlassian = {
    catalogId: "atlassian",
    resourceConstraints: { jiraProjects: ["DEMO"], confluenceSpaces: ["DOCS"] },
  };
  it("permits the chosen Notion parent and denies missing, other, mixed and opaque targets", () => {
    expect(
      integrationResourceDenial(notion, write, {
        parent: { page_id: "a".repeat(32) },
        content: "Notes",
      }),
    ).toBeUndefined();
    for (const args of [
      {},
      { page_id: "b".repeat(32) },
      { parent: { page_id: "a".repeat(32) }, page_id: "b".repeat(32) },
      { parent: "unknown" },
      { parent: { page_id: "a".repeat(32) }, target_id: "b".repeat(32) },
    ])
      expect(integrationResourceDenial(notion, write, args)).toBe(
        "Choose the allowed Notion destination before writing here.",
      );
    expect(
      integrationResourceDenial({ catalogId: "notion" }, write, { page_id: "a".repeat(32) }),
    ).toBeDefined();
    expect(
      integrationResourceDenial(
        notion,
        { id: "synthetic_search", description: "Search pages" },
        {},
      ),
    ).toBeUndefined();
    expect(
      integrationResourceDenial(
        notion,
        { id: "synthetic_search", description: "Search pages" },
        { action: "delete" },
      ),
    ).toBeDefined();
  });
  it("enforces every Jira project and Confluence space, including nested and query targets", () => {
    for (const args of [
      { projectKey: "DEMO" },
      { fields: { project: { key: "DEMO" } } },
      { issueIdOrKey: "DEMO-12" },
      { spaceKey: "DOCS" },
      { jql: 'project = "DEMO"' },
      { cql: 'space = "DOCS"' },
    ])
      expect(integrationResourceDenial(atlassian, write, args)).toBeUndefined();
    for (const args of [
      { projectKey: "OTHER" },
      { spaceKey: "OTHER" },
      { projectKey: "DEMO", issueIdOrKey: "OTHER-2" },
      { issueId: "123", projectKey: "DEMO" },
      { pageId: "123", spaceKey: "DOCS" },
      { jql: "project = DEMO OR project = OTHER" },
      {},
      { projectKey: ["DEMO", "OTHER"] },
      { projectKey: "DEMO", query: "outside scope" },
    ])
      expect(integrationResourceDenial(atlassian, write, args)).toBe(
        "This project or space is outside the allowed destinations.",
      );
  });
  it("denies outside the constraint before dispatch for direct calls and approved replay", async () => {
    const f = fixture();
    const name = tools[0]!.name;
    f.assignment.server.catalogId = "notion";
    f.assignment.server.resourceConstraints = notion.resourceConstraints;
    f.assignment.server.manifest = {
      ...manifest,
      tools: manifest.tools.map((tool) => ({ ...tool, description: "Write an item." })),
    };
    const call = { ...direct(name), args: { page_id: "b".repeat(32) } };
    expect(await integrationApprovalForCall(f.db as never, call.route, context, call.args)).toBe(
      "disabled",
    );
    expect(await collect(f.connector, call)).toMatchObject([
      { type: "error", message: "Choose the allowed Notion destination before writing here." },
    ]);
    expect(f.calls).toEqual([]);
    expect(
      await collect(f.connector, { ...call, args: { page_id: "a".repeat(32) } }),
    ).toMatchObject([{ type: "result" }]);
    expect(f.calls).toEqual([name]);
    await f.connector.close();
  });
});
