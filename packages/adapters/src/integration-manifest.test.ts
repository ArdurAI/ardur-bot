import { describe, expect, it, vi } from "vitest";
import { McpSession } from "./mcp-transport.js";

async function sessionWithPages(page: (cursor: string | undefined) => unknown) {
  const session = new McpSession();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = (await request.json()) as {
      id?: number;
      method: string;
      params?: { cursor?: string };
    };
    if (body.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic", version: "synthetic-1" },
        },
      });
    if (body.method === "tools/list")
      return Response.json({ jsonrpc: "2.0", id: body.id, result: page(body.params?.cursor) });
    return new Response(null, { status: 202 });
  });
  await session.connectRemote({
    url: "https://example.test/mcp",
    network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
  });
  return session;
}

describe("complete and bounded MCP manifests", () => {
  it("includes every advertised page and the negotiated server version", async () => {
    const session = await sessionWithPages((cursor) =>
      cursor
        ? { tools: [{ name: "synthetic_second", inputSchema: { type: "object" } }] }
        : {
            tools: [{ name: "synthetic_first", inputSchema: { type: "object" } }],
            nextCursor: "next",
          },
    );
    try {
      expect((await session.listTools()).tools.map((tool) => tool.name)).toEqual([
        "synthetic_first",
        "synthetic_second",
      ]);
      expect(session.serverVersion()).toBe("synthetic-1");
    } finally {
      await session.close();
    }
  });
  it("rejects repeating cursors and bounds empty pages", async () => {
    for (const repeat of [true, false]) {
      let count = 0;
      const session = await sessionWithPages(() => ({
        tools: [],
        nextCursor: repeat ? "same" : String(++count),
      }));
      try {
        await expect(session.listTools()).rejects.toThrow(/cursor|page limit/);
      } finally {
        await session.close();
      }
    }
  });
  it("rejects unbounded tool lists", async () => {
    const session = await sessionWithPages(() => ({
      tools: Array.from({ length: 2001 }, (_, index) => ({
        name: `synthetic_${index}`,
        inputSchema: { type: "object" },
      })),
    }));
    try {
      await expect(session.listTools()).rejects.toThrow("too large");
    } finally {
      await session.close();
    }
  });
});
