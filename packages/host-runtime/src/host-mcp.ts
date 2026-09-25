import type {
  HostMcpRegistration,
  HostOperation,
  HostScope,
} from "@ardurbot/contracts/host-bridge";
import { HostMcpRegistrationSchema } from "@ardurbot/contracts/host-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { argumentSecrets, McpLogBuffer, redactMcpValue } from "./mcp-diagnostics.js";

type McpOperation = Extract<HostOperation, { serverId: string }>;
type Entry = {
  registration: HostMcpRegistration;
  logs: McpLogBuffer;
  client?: Client;
  connecting?: Promise<Client>;
};

/** Only the paired host's configuration channel can populate this process allowlist. */
export class HostMcpServers {
  private readonly entries = new Map<string, Entry>();
  constructor(registrations: readonly HostMcpRegistration[] = []) {
    if (registrations.length > 200) throw new Error("Too many local servers.");
    for (const value of registrations) {
      const registration = HostMcpRegistrationSchema.parse(value);
      if (this.entries.has(registration.serverId)) throw new Error("Duplicate local server.");
      this.entries.set(registration.serverId, {
        registration,
        logs: new McpLogBuffer(this.secrets(registration)),
      });
    }
  }
  private secrets(registration: HostMcpRegistration) {
    return [
      ...registration.redactions,
      ...Object.values(registration.env),
      ...argumentSecrets(registration.args),
    ];
  }
  has(serverId: string, revision: number) {
    return this.entries.get(serverId)?.registration.revision === revision;
  }
  async replace(registrations: readonly HostMcpRegistration[]) {
    const next = new HostMcpServers(registrations);
    for (const [id, entry] of this.entries) {
      const replacement = next.entries.get(id);
      if (
        replacement &&
        JSON.stringify(replacement.registration) === JSON.stringify(entry.registration)
      ) {
        next.entries.set(id, entry);
      } else {
        await entry.connecting?.catch(() => undefined);
        await entry.client?.close().catch(() => undefined);
        entry.logs.finish();
      }
    }
    this.entries.clear();
    for (const [id, entry] of next.entries) this.entries.set(id, entry);
  }
  private async client(entry: Entry, signal: AbortSignal) {
    if (entry.client) return entry.client;
    if (entry.connecting) return entry.connecting;
    const registration = entry.registration;
    const client = new Client({ name: "ardurbot-host", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: registration.command,
      args: registration.args,
      env: registration.env,
      cwd: registration.cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => entry.logs.append(chunk));
    client.onerror = (error) => entry.logs.status("error", error);
    client.onclose = () => {
      entry.client = undefined;
      entry.logs.finish();
    };
    entry.connecting = client
      .connect(transport, { signal, timeout: 15_000 })
      .then(() => {
        entry.client = client;
        entry.logs.status("running");
        return client;
      })
      .catch(async (error: unknown) => {
        entry.logs.status("error", error);
        await client.close().catch(() => undefined);
        throw new Error(entry.logs.snapshot().lastError ?? "Server failed.");
      })
      .finally(() => {
        entry.connecting = undefined;
      });
    return entry.connecting;
  }
  async execute(operation: McpOperation, scope: HostScope, signal: AbortSignal): Promise<unknown> {
    const entry = this.entries.get(operation.serverId);
    if (!entry && (operation.op === "mcp.stop" || operation.op === "mcp.status"))
      return { status: "stopped", lastError: null, lines: [], updatedAt: null };
    if (
      !entry ||
      entry.registration.userId !== scope.userId ||
      entry.registration.spaceId !== scope.spaceId ||
      entry.registration.revision !== operation.revision
    )
      throw new Error("This local server is not authorized on this computer.");
    if (operation.op === "mcp.status") return entry.logs.snapshot();
    if (operation.op === "mcp.stop") {
      await entry.connecting?.catch(() => undefined);
      await entry.client?.close();
      entry.client = undefined;
      entry.logs.finish();
      return entry.logs.snapshot();
    }
    try {
      const client = await this.client(entry, signal);
      if (operation.op === "mcp.tools") {
        const tools = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools({ cursor }, { signal, timeout: 15_000 });
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (tools.length > 2000 || cursors.size >= 100 || (cursor && cursors.has(cursor)))
            throw new Error("MCP tool manifest is too large.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return redactMcpValue(
          { tools, serverVersion: client.getServerVersion()?.version ?? null },
          this.secrets(entry.registration),
        );
      }
      const result = await client.callTool(
        { name: operation.name, arguments: operation.args },
        undefined,
        { signal, timeout: 120_000 },
      );
      return redactMcpValue(result, this.secrets(entry.registration));
    } catch (error) {
      entry.logs.status("error", error);
      throw new Error(entry.logs.snapshot().lastError ?? "Server failed.");
    }
  }
  async close() {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await entry.connecting?.catch(() => undefined);
        await entry.client?.close().catch(() => undefined);
        entry.logs.finish();
      }),
    );
  }
}
