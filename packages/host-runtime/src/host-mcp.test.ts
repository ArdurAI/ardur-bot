import { PassThrough } from "node:stream";
import type { HostMcpRegistration } from "@ardurbot/contracts/host-bridge";
import { HostMcpRegistrationSchema } from "@ardurbot/contracts/host-bridge";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ starts: vi.fn(), closes: vi.fn(), calls: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    onclose?: () => void;
    async connect(transport: { stderr: PassThrough }) {
      fixture.starts();
      transport.stderr.write("TOKEN=fixture-secret\n");
    }
    async close() {
      fixture.closes();
      this.onclose?.();
    }
    async listTools() {
      return { tools: [{ name: "read_fixture", inputSchema: { type: "object" } }] };
    }
    getServerVersion() {
      return { version: "1.0.0" };
    }
    async callTool() {
      fixture.calls();
      return { content: [{ type: "text", text: "fixture-secret" }] };
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = new PassThrough();
  },
}));

import { HostMcpServers } from "./host-mcp.js";

describe("paired host MCP process ownership", () => {
  it("starts only a registered revision, redacts logs and results, and closes removed processes", async () => {
    const registration: HostMcpRegistration = HostMcpRegistrationSchema.parse({
      serverId: "server",
      spaceId: "space",
      userId: "owner",
      revision: 1,
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "fixture-secret" },
      cwd: "/fixture",
    });
    const servers = new HostMcpServers([registration]);
    const scope = { spaceId: "space", userId: "owner", botId: "bot", runId: "run" };
    const signal = new AbortController().signal;
    await expect(
      servers.execute(
        { op: "mcp.tools", serverId: "server", revision: 1 },
        { ...scope, userId: "foreign" },
        signal,
      ),
    ).rejects.toThrow("authorized");
    expect(fixture.starts).not.toHaveBeenCalled();
    expect(
      await servers.execute({ op: "mcp.tools", serverId: "server", revision: 1 }, scope, signal),
    ).toMatchObject({ serverVersion: "1.0.0" });
    const result = await servers.execute(
      { op: "mcp.call", serverId: "server", revision: 1, name: "read_fixture", args: {} },
      scope,
      signal,
    );
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(
      await servers.execute({ op: "mcp.status", serverId: "server", revision: 1 }, scope, signal),
    ).toMatchObject({ status: "running", lines: ["TOKEN=[redacted]"] });
    await servers.replace([]);
    expect(fixture.closes).toHaveBeenCalledTimes(1);
    await expect(
      servers.execute(
        { op: "mcp.call", serverId: "server", revision: 1, name: "read_fixture", args: {} },
        scope,
        signal,
      ),
    ).rejects.toThrow();
    expect(fixture.calls).toHaveBeenCalledTimes(1);
  });
});
