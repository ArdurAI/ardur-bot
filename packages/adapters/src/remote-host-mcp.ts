import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { HostOperation } from "@ardurbot/contracts/host-bridge";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpSession } from "./mcp-transport.js";

export interface McpHostClient {
  result(operation: HostOperation, context: Partial<AdapterContext>): Promise<unknown>;
}
export type McpSessionPort = Pick<McpSession, "listTools" | "callTool" | "serverVersion" | "close">;
export class RemoteHostMcpSession implements McpSessionPort {
  private version: string | null = null;
  constructor(
    private readonly host: McpHostClient,
    private readonly server: { id: string; revision: number },
    private readonly context: AdapterContext,
  ) {}
  async listTools(options?: { signal?: AbortSignal }) {
    const result = await this.host.result(
      { op: "mcp.tools", serverId: this.server.id, revision: this.server.revision },
      { ...this.context, signal: options?.signal ?? this.context.signal },
    );
    if (
      result &&
      typeof result === "object" &&
      "serverVersion" in result &&
      typeof result.serverVersion === "string"
    )
      this.version = result.serverVersion;
    return ListToolsResultSchema.parse(result);
  }
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal },
  ) {
    return CallToolResultSchema.parse(
      await this.host.result(
        { op: "mcp.call", serverId: this.server.id, revision: this.server.revision, name, args },
        { ...this.context, signal: options?.signal ?? this.context.signal },
      ),
    );
  }
  serverVersion() {
    return this.version;
  }
  async close() {
    /* Host sessions belong to the local registration, not this worker lease. */
  }
}
