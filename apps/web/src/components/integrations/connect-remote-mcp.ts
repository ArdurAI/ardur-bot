import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

/** Returns the server id, or null when the person cancels browser sign-in. */
export async function connectRemoteMcp(input: {
  name: string;
  endpoint: string;
  secret?: string;
  botId?: string;
  authType?: "oauth" | "none" | "bearer" | "header";
}): Promise<string | null> {
  const endpoint = input.endpoint.trim();
  const secret = input.secret?.trim();
  const existing = (await rpc.mcp.servers.list()).find(
    (server) =>
      server.endpoint && normalizedEndpoint(server.endpoint) === normalizedEndpoint(endpoint),
  );
  const server =
    existing ??
    (await rpc.mcp.servers.create({
      slug: `integration-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      transport: "streamable_http",
      endpoint,
      ...(secret ? { secret } : {}),
    }));
  if (existing && secret) await rpc.mcp.servers.update({ id: existing.id, secret });
  if (input.authType === "none" || input.authType === "bearer" || input.authType === "header") {
    await rpc.mcp.servers.tools({ serverId: server.id });
  } else {
    const result = await connectMcpOauth(server.id);
    if (result === "cancelled") {
      if (!existing) {
        try {
          await rpc.mcp.servers.remove({ id: server.id });
        } catch {
          await rpc.mcp.servers.update({ id: server.id, enabled: false });
        }
      }
      return null;
    }
  }
  const stored = (await rpc.mcp.servers.list()).find((candidate) => candidate.id === server.id);
  if (stored?.connectionState !== "connected") {
    throw new Error("Could not connect this server. Check its configuration and try again.");
  }
  if (input.botId) await rpc.mcp.assignments.approve({ botId: input.botId, serverId: server.id });
  return server.id;
}

export function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.protocol}//${url.host}${path}`;
}
